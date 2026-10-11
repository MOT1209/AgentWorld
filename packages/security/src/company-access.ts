/**
 * Company-scoped visibility for human principals.
 *
 * Rules (one place, so routes cannot drift):
 *  - Platform OWNER sees every company.
 *  - Anyone else sees the companies they own (`Company.ownerId`) plus those
 *    granted through a `CompanyAccess` row.
 *  - Visibility only. What a user may DO inside a visible company is still
 *    decided by their global role permissions (`requirePermission`).
 *  - Rows with no company (`companyId = null`) belong to the shared world and
 *    stay visible to every authenticated user.
 *  - An invisible company answers 404, not 403, so ids cannot be probed.
 */
import type { DbClient } from "../../database/src/index.js";
import { forbidden, notFound, UserRole } from "../../shared/src/index.js";
import type { Principal } from "./rbac.js";

export type CompanyScope = { all: true } | { all: false; companyIds: ReadonlySet<string> };

export async function companyScope(db: DbClient, principal: Principal): Promise<CompanyScope> {
  if (principal.role === UserRole.OWNER) return { all: true };
  const [owned, granted] = await Promise.all([
    db.company.findMany({ where: { ownerId: principal.userId }, select: { id: true } }),
    db.companyAccess.findMany({ where: { userId: principal.userId }, select: { companyId: true } }),
  ]);
  return {
    all: false,
    companyIds: new Set([...owned.map((row) => row.id), ...granted.map((row) => row.companyId)]),
  };
}

/** True when the scope may see a row tied to `companyId` (null = shared world). */
export function scopeAllows(scope: CompanyScope, companyId: string | null | undefined): boolean {
  if (scope.all || companyId === null || companyId === undefined) return true;
  return scope.companyIds.has(companyId);
}

/** Prisma `where` fragment for a nullable `companyId` column; undefined = no filter. */
export function scopeWhere(scope: CompanyScope): { OR: Array<{ companyId: { in: string[] } | null }> } | undefined {
  if (scope.all) return undefined;
  return { OR: [{ companyId: { in: [...scope.companyIds] } }, { companyId: null }] };
}

export async function assertCompanyAccess(db: DbClient, principal: Principal, companyId: string): Promise<void> {
  const scope = await companyScope(db, principal);
  if (!scopeAllows(scope, companyId)) throw notFound("Company", companyId);
}

/** Platform-wide aggregates (ledger totals, verification) are OWNER-only once companies are isolated. */
export function assertPlatformWide(scope: CompanyScope): void {
  if (!scope.all) throw forbidden("Platform-wide figures are limited to the platform owner");
}

/** Only the platform owner or the company's owner may change who can see it. */
export async function assertCanManageAccess(db: DbClient, principal: Principal, companyId: string): Promise<void> {
  if (principal.role === UserRole.OWNER) return;
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerId: true } });
  if (company === null) throw notFound("Company", companyId);
  if (company.ownerId !== principal.userId) {
    await assertCompanyAccess(db, principal, companyId); // 404 when not even visible
    throw forbidden("Only the company owner can manage who sees this company");
  }
}

interface WalletRef {
  ownerType: string;
  ownerId: string;
}

/**
 * Filters wallets to those the scope may see: company wallets of visible
 * companies, the principal's own user wallet, and agent wallets whose agent
 * is unaffiliated or works for a visible company. Other users' wallets are
 * hidden from non-owners.
 */
export async function filterVisibleWallets<T>(
  db: DbClient,
  principal: Principal,
  scope: CompanyScope,
  items: T[],
  pick: (item: T) => WalletRef,
): Promise<T[]> {
  if (scope.all) return items;
  const agentIds = items.map(pick).filter((w) => w.ownerType === "AGENT").map((w) => w.ownerId);
  const agents =
    agentIds.length > 0
      ? await db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, currentCompanyId: true } })
      : [];
  const agentCompany = new Map(agents.map((agent) => [agent.id, agent.currentCompanyId]));
  return items.filter((item) => {
    const wallet = pick(item);
    if (wallet.ownerType === "COMPANY") return scope.companyIds.has(wallet.ownerId);
    if (wallet.ownerType === "USER") return wallet.ownerId === principal.userId;
    if (wallet.ownerType === "AGENT") return scopeAllows(scope, agentCompany.get(wallet.ownerId) ?? null);
    return false;
  });
}
