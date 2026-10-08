/**
 * Periodic payroll.
 *
 * `paySalary` is a manual single payment; this service runs the recurring
 * cycle from the simulation heartbeat. It pays each active member a daily
 * share of their annual salary (annual / 365, floored), and is idempotent by
 * construction: every payment carries an idempotency key derived from
 * (company, agent, simulated day), so a retried or repeated tick can never
 * double-pay a day. Companies that cannot cover payroll get a recorded
 * shortfall result, not a crash -- the treasury refuses to overdraft and
 * payroll surfaces what could not be paid.
 */
import { Money, validationError } from "../../shared/src/index.js";
import type { ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import { pay } from "./ledger.service.js";
import { getTreasury } from "./treasury.service.js";
import { ensureWallet } from "./wallet.service.js";

export interface PayrollContext {
  actor: ActorRef;
  correlationId?: string;
}

export interface PayrollCycleResult {
  simulatedDay: string;
  companiesProcessed: number;
  paid: Array<{ companyId: string; agentId: string; amountMinor: number; replayed: boolean }>;
  shortfalls: Array<{ companyId: string; agentId: string; dueMinor: number; reason: string }>;
  zeroSalarySkipped: number;
}

/** Daily share of an annual salary, in minor units. */
export function dailySalaryMinor(annualMinor: number): number {
  if (!Number.isInteger(annualMinor) || annualMinor < 0) {
    throw validationError("Annual salary must be a non-negative integer of minor units");
  }
  return Math.floor(annualMinor / 365);
}

/** YYYY-MM-DD of a simulated timestamp, the payroll period key. */
export function payrollDayKey(simulatedNow: Date): string {
  const y = simulatedNow.getUTCFullYear();
  const m = String(simulatedNow.getUTCMonth() + 1).padStart(2, "0");
  const d = String(simulatedNow.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Run one payroll pass. Pay for (company, agent, day) is keyed idempotently;
 * calling this again for the same simulated day replays as a no-op.
 */
export async function runPayrollCycle(
  db: DbClient,
  input: { simulatedNow: Date; companyId?: string },
  ctx: PayrollContext,
): Promise<PayrollCycleResult> {
  const day = payrollDayKey(input.simulatedNow);
  const result: PayrollCycleResult = {
    simulatedDay: day,
    companiesProcessed: 0,
    paid: [],
    shortfalls: [],
    zeroSalarySkipped: 0,
  };

  const companies = await db.company.findMany({
    where: input.companyId !== undefined ? { id: input.companyId } : {},
    select: { id: true, name: true },
  });

  for (const company of companies) {
    const members = await db.companyMember.findMany({
      where: { companyId: company.id, isActive: true, salaryMinor: { gt: 0 } },
      select: { agentId: true, salaryMinor: true },
    });
    if (members.length === 0) continue;
    result.companiesProcessed += 1;

    // Resolve the treasury once; a company with no treasury wallet gets one at zero.
    let treasuryId: string;
    try {
      treasuryId = (await getTreasury(db, company.id)).id;
    } catch {
      for (const m of members) {
        result.shortfalls.push({ companyId: company.id, agentId: m.agentId, dueMinor: dailySalaryMinor(m.salaryMinor), reason: "treasury-unavailable" });
      }
      continue;
    }

    for (const member of members) {
      const due = dailySalaryMinor(member.salaryMinor);
      if (due <= 0) {
        result.zeroSalarySkipped += 1;
        continue;
      }
      const idempotencyKey = `payroll:${company.id}:${member.agentId}:${day}`;
      try {
        const agentWallet = await ensureWallet(db, { ownerType: "AGENT", ownerId: member.agentId });
        const outcome = await pay({
          fromWalletId: treasuryId,
          toWalletId: agentWallet.id,
          amount: Money.fromMinor(due),
          type: "SALARY",
          description: `Daily payroll for ${day} (${company.name})`,
          beneficiaryAgentId: member.agentId,
          referenceType: "PAYROLL",
          referenceId: day,
          idempotencyKey,
          actor: ctx.actor,
          correlationId: ctx.correlationId,
          client: db,
        });
        result.paid.push({
          companyId: company.id,
          agentId: member.agentId,
          amountMinor: due,
          replayed: outcome.replayed,
        });
      } catch (error) {
        // Insufficient funds and other refusals are recorded, never fatal.
        result.shortfalls.push({
          companyId: company.id,
          agentId: member.agentId,
          dueMinor: due,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}
