/**
 * Wallet lifecycle.
 *
 * A wallet is a balance container plus identity. It is deliberately NOT the
 * place where money moves: every mutation of `balanceMinor` goes through
 * LedgerService, which appends a Transaction in the same database transaction.
 * Nothing in this file writes a balance.
 *
 * Wallet ownership is polymorphic (AGENT | USER | COMPANY) so an agent, a human
 * and a company can hold money in one uniform table without three nullable
 * foreign keys. Integrity is enforced by always going through `ensureWallet`.
 */
import { conflict, notFound, validationError, DEFAULT_CURRENCY } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Wallet } from "../../database/src/types.js";
import type { WalletOwnerType } from "../../shared/src/index.js";

export interface WalletAddress {
  ownerType: WalletOwnerType;
  ownerId: string;
  currency?: string;
}

export function addressKey(address: WalletAddress): string {
  return `${address.ownerType}:${address.ownerId}:${address.currency ?? DEFAULT_CURRENCY}`;
}

/** Finds a wallet, or creates a zero-balance one. Idempotent. */
export async function ensureWallet(
  db: DbClient,
  address: WalletAddress,
): Promise<Wallet> {
  const currency = address.currency ?? DEFAULT_CURRENCY;
  const existing = await db.wallet.findUnique({
    where: {
      ownerType_ownerId_currency: {
        ownerType: address.ownerType,
        ownerId: address.ownerId,
        currency,
      },
    },
  });
  if (existing !== null) return existing;

  // Two concurrent creators can both miss; the unique constraint decides, and
  // the loser re-reads rather than failing the whole operation.
  try {
    return await db.wallet.create({
      data: { ownerType: address.ownerType, ownerId: address.ownerId, currency },
    });
  } catch (error) {
    const retry = await db.wallet.findUnique({
      where: {
        ownerType_ownerId_currency: {
          ownerType: address.ownerType,
          ownerId: address.ownerId,
          currency,
        },
      },
    });
    if (retry !== null) return retry;
    throw error;
  }
}

export async function requireWallet(db: DbClient, walletId: string): Promise<Wallet> {
  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (wallet === null) throw notFound("Wallet", walletId);
  return wallet;
}

export async function requireWalletByAddress(
  db: DbClient,
  address: WalletAddress,
): Promise<Wallet> {
  const wallet = await ensureWallet(db, address);
  if (wallet.isFrozen) {
    throw conflict("Wallet is frozen and cannot be used", { walletId: wallet.id });
  }
  return wallet;
}

export interface WalletWithOwner {
  wallet: Wallet;
  ownerName: string | null;
  ownerTitle: string | null;
  companyId: string | null;
  currentLocationId: string | null;
}

/** Dashboard feed: wallets joined to a display name for their owner. */
export async function listWallets(db: DbClient): Promise<WalletWithOwner[]> {
  const rows = await db.wallet.findMany({ orderBy: { createdAt: "asc" } });
  const agentIds = rows.filter((row) => row.ownerType === "AGENT").map((row) => row.ownerId);
  const userIds = rows.filter((row) => row.ownerType === "USER").map((row) => row.ownerId);

  const [agents, users] = await Promise.all([
    agentIds.length > 0
      ? db.agent.findMany({
          where: { id: { in: agentIds } },
          select: { id: true, name: true, title: true, currentCompanyId: true, currentLocationId: true },
        })
      : Promise.resolve([]),
    userIds.length > 0
      ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
      : Promise.resolve([]),
  ]);

  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const userMap = new Map(users.map((user) => [user.id, user.displayName]));

  return rows.map((row) => {
    if (row.ownerType === "AGENT") {
      const agent = agentMap.get(row.ownerId);
      return {
        wallet: row,
        ownerName: agent?.name ?? null,
        ownerTitle: agent?.title ?? null,
        companyId: agent?.currentCompanyId ?? null,
        currentLocationId: agent?.currentLocationId ?? null,
      };
    }
    return {
      wallet: row,
      ownerName: userMap.get(row.ownerId) ?? null,
      ownerTitle: null,
      companyId: null,
      currentLocationId: null,
    };
  });
}

export async function setWalletFrozen(
  db: DbClient,
  walletId: string,
  frozen: boolean,
): Promise<Wallet> {
  const wallet = await requireWallet(db, walletId);
  if (wallet.isFrozen === frozen) return wallet;
  return db.wallet.update({ where: { id: walletId }, data: { isFrozen: frozen } });
}

export function assertPositiveAmount(amountMinor: number, label = "amount"): void {
  if (!Number.isInteger(amountMinor)) {
    throw validationError(`${label} must be an integer number of minor units`);
  }
  if (amountMinor <= 0) {
    throw validationError(`${label} must be greater than zero`, { amountMinor });
  }
}
