/**
 * AI cost charging -- the bridge from estimated usage to the real economy.
 *
 * One rule, stated once: the ledger is the only writer of balances. When a
 * call's estimated cost reaches the configured threshold
 * (AI_CHARGE_THRESHOLD_MINOR), this module moves FEE money from the company
 * treasury through LedgerService and records the fact once per charge
 * (AI_COST_CHARGED). No parallel balance, no direct wallet writes.
 *
 * The gateway calls this once per recorded `AiUsage` row, keyed by that row's
 * id, so a retried or replayed charge is a ledger no-op rather than a double
 * charge.
 */
import { Money } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { pay } from "../../economy/src/ledger.service.js";
import { SYSTEM_ACTOR } from "../../shared/src/actor.js";
import { getConfig } from "../../shared/src/config.js";
import { logger } from "../../shared/src/index.js";

const log = logger.child({ component: "ai.cost" });

/**
 * Charges `amountMinor` of AI spend to the company treasury as a FEE.
 *
 * The treasury wallet is resolved from the company (the only wallet the
 * ledger will debit here); `treasuryWalletId` is an optional cross-check for
 * callers that already know it -- when supplied and different, the charge is
 * refused rather than debited from an unexpected wallet. Returns the
 * transaction id, or null when there is nothing to charge (below threshold /
 * no wallet / already charged).
 */
export async function chargeAiSpend(
  db: DbClient,
  input: {
    companyId: string;
    /** Optional explicit treasury wallet; resolved from the company when absent. */
    treasuryWalletId?: string | null;
    amountMinor: number;
    /** Stable per-charge key so a retry replays as a ledger no-op. */
    idempotencyKey?: string;
    correlationId?: string;
  },
): Promise<{ transactionId: string; chargedMinor: number } | null> {
  if (input.amountMinor <= 0) return null;
  const threshold = getConfig().aiGateway.chargeThresholdMinor;
  if (input.amountMinor < threshold) return null;

  const wallet = await db.wallet.findFirst({
    where: { ownerType: "COMPANY", ownerId: input.companyId },
  });
  if (wallet === null) return null;
  if (input.treasuryWalletId !== undefined && input.treasuryWalletId !== null && wallet.id !== input.treasuryWalletId) {
    return null;
  }

  const description = `AI usage fees (${input.amountMinor} minor units estimated cost)`;
  try {
    // Charge from the company wallet to the system sink wallet (treasury
    // withdrawal-equivalent), which is the ledger's FEE path.
    const sink = await ensureSinkWallet(db);
    const result = await pay({
      fromWalletId: wallet.id,
      toWalletId: sink.id,
      amount: Money.fromMinor(input.amountMinor, wallet.currency),
      type: "FEE",
      description,
      actor: SYSTEM_ACTOR,
      correlationId: input.correlationId,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    if (result.replayed) return null;
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.AI_COST_CHARGED,
      actor: SYSTEM_ACTOR,
      correlationId: input.correlationId,
      targetType: "Wallet",
      targetId: wallet.id,
      payload: {
        companyId: input.companyId,
        walletId: wallet.id,
        amountMinor: input.amountMinor,
        currency: wallet.currency,
        transactionId: result.creditTransaction.id,
      },
    });
    return { transactionId: result.creditTransaction.id, chargedMinor: input.amountMinor };
  } catch (error) {
    // A failed charge is logged and surfaced later; it must never break the
    // completion that produced the usage.
    log.warn("AI spend charge failed", {
      action: "ai.charge_failed",
      result: "ERROR",
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function ensureSinkWallet(db: DbClient): Promise<{ id: string }> {
  const { ensureWallet } = await import("../../economy/src/wallet.service.js");
  const existing = await db.wallet.findFirst({
    where: { ownerType: "COMPANY", ownerId: "system-ai-fees" },
  });
  if (existing !== null) return existing;
  return ensureWallet(db, { ownerType: "COMPANY", ownerId: "system-ai-fees" });
}
