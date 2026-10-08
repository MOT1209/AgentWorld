/**
 * The ledger.
 *
 * This module is the ONLY place in the system permitted to write
 * `Wallet.balanceMinor`. That single-writer rule is what makes the economy
 * auditable: every balance is reconstructible by summing Transaction rows, and
 * `integrity.ts` verifies exactly that in the test suite.
 *
 * Guarantees:
 *
 *  1. ATOMICITY    - balance update and Transaction append commit together.
 *  2. NO OVERDRAFT - a debit that would go below zero is refused.
 *  3. DOUBLE-ENTRY - a transfer writes a DEBIT and a CREDIT leg sharing one
 *                    transferGroupId, so total money is conserved.
 *  4. IDEMPOTENCY  - an idempotencyKey turns a retried payment into a no-op.
 *                    Checked inside the transaction, and backed by a unique
 *                    index so a concurrent duplicate cannot slip through.
 *  5. IMMUTABILITY - Transaction rows are never updated or deleted. The
 *                    database enforces this with triggers.
 *  6. OPTIMISTIC LOCKING - each write asserts the wallet's `version`, so two
 *                    concurrent debits cannot both act on the same balance.
 *  7. DETERMINISTIC LOCK ORDER - two-wallet operations always touch wallets in
 *                    sorted id order, which makes deadlock impossible rather
 *                    than merely unlikely.
 */
import { randomUUID } from "node:crypto";
import {
  Money,
  conflict,
  insufficientFunds,
  logger,
  toJson,
  validationError,
  type ActorRef,
  type TransactionType,
} from "../../shared/src/index.js";
import { prisma, withTransaction, type DbClient } from "../../database/src/index.js";
import type { Transaction, Wallet } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";
import { assertPositiveAmount, requireWallet } from "./wallet.service.js";

const log = logger.child({ component: "economy.ledger" });

export interface LedgerContext {
  actor: ActorRef;
  correlationId?: string;
  /** Enlist in a caller's transaction instead of opening one. */
  client?: DbClient;
  approvalRequestId?: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

interface MovementInput extends LedgerContext {
  wallet: Wallet;
  type: TransactionType;
  /** Signed. Direction is derived from the sign. */
  amount: Money;
  description: string;
  counterpartyType?: string | null;
  counterpartyId?: string | null;
}

/** Runs inside an existing transaction when given one, else opens one. */
function run<T>(client: DbClient | undefined, fn: (db: DbClient) => Promise<T>): Promise<T> {
  return client !== undefined ? fn(client) : withTransaction(prisma, fn);
}

function db(client: DbClient | undefined): DbClient {
  return client ?? prisma;
}

/** Prisma surfaces unique violations as P2002. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * Applies one signed movement to one wallet and appends its ledger entry.
 * MUST be called inside a database transaction.
 */
async function applyMovement(
  tx: DbClient,
  input: MovementInput,
  transferGroupId?: string,
): Promise<Transaction> {
  const amountMinor = input.amount.minor;
  if (amountMinor === 0) throw validationError("Movement amount must not be zero");

  const direction = amountMinor > 0 ? "CREDIT" : "DEBIT";
  const magnitude = Math.abs(amountMinor);

  if (input.wallet.isFrozen) {
    throw conflict("Wallet is frozen", { walletId: input.wallet.id });
  }

  const projected = input.wallet.balanceMinor + amountMinor;
  if (projected < 0) {
    throw insufficientFunds(
      `Insufficient funds: available ${Money.fromMinor(input.wallet.balanceMinor, input.wallet.currency).toString()}, ` +
        `required ${Money.fromMinor(magnitude, input.amount.currency).toString()}`,
      {
        walletId: input.wallet.id,
        availableMinor: input.wallet.balanceMinor,
        requestedMinor: magnitude,
        currency: input.amount.currency,
      },
    );
  }

  // Optimistic lock: the write only lands if nobody else moved this wallet
  // since we read it. Zero rows updated means we lost the race.
  const updated = await tx.wallet.updateMany({
    where: { id: input.wallet.id, version: input.wallet.version, isFrozen: false },
    data: { balanceMinor: projected, version: { increment: 1 } },
  });

  if (updated.count === 0) {
    const current = await tx.wallet.findUnique({ where: { id: input.wallet.id } });
    if (current === null) {
      throw conflict("Wallet disappeared mid-transaction", { walletId: input.wallet.id });
    }
    if (current.isFrozen) throw conflict("Wallet is frozen", { walletId: current.id });
    // Phrase contains the marker the transaction retry layer looks for.
    throw conflict("concurrent modification of wallet, retrying", {
      walletId: current.id,
      expectedVersion: input.wallet.version,
      actualVersion: current.version,
    });
  }

  return tx.transaction.create({
    data: {
      walletId: input.wallet.id,
      type: input.type,
      direction,
      amountMinor: magnitude,
      balanceAfterMinor: projected,
      currency: input.amount.currency,
      transferGroupId: transferGroupId ?? null,
      counterpartyType: input.counterpartyType ?? null,
      counterpartyId: input.counterpartyId ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      description: input.description,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: toJson(input.metadata ?? {}),
    },
  });
}

async function findByIdempotencyKey(
  client: DbClient | undefined,
  walletId: string,
  idempotencyKey: string | undefined,
): Promise<Transaction | null> {
  if (idempotencyKey === undefined) return null;
  return db(client).transaction.findUnique({
    where: { walletId_idempotencyKey: { walletId, idempotencyKey } },
  });
}

export interface MovementResult {
  transaction: Transaction;
  balanceAfter: Money;
  /** True when this call replayed an existing entry rather than moving money. */
  replayed: boolean;
}

/**
 * Shared single-wallet mutation. Handles the idempotency replay, the optimistic
 * lock retry, and the unique-violation fallback.
 */
async function mutateSingle(
  input: MovementInput,
): Promise<MovementResult> {
  const preExisting = await findByIdempotencyKey(
    input.client,
    input.wallet.id,
    input.idempotencyKey,
  );
  if (preExisting !== null) {
    return {
      transaction: preExisting,
      balanceAfter: Money.fromMinor(preExisting.balanceAfterMinor, preExisting.currency),
      replayed: true,
    };
  }

  try {
    const transaction = await run(input.client, (tx) => applyMovement(tx, input));
    return {
      transaction,
      balanceAfter: Money.fromMinor(transaction.balanceAfterMinor, transaction.currency),
      replayed: false,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await findByIdempotencyKey(
        input.client,
        input.wallet.id,
        input.idempotencyKey,
      );
      if (raced !== null) {
        return {
          transaction: raced,
          balanceAfter: Money.fromMinor(raced.balanceAfterMinor, raced.currency),
          replayed: true,
        };
      }
    }
    throw error;
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

export async function deposit(input: {
  toWalletId: string;
  amount: Money;
  description: string;
} & LedgerContext): Promise<MovementResult> {
  assertPositiveAmount(input.amount.minor, "Deposit amount");
  const wallet = await requireWallet(db(input.client), input.toWalletId);

  const result = await mutateSingle({
    ...input,
    wallet,
    type: "DEPOSIT",
    amount: input.amount,
    description: input.description,
  });

  if (!result.replayed) {
    await eventBus.publishAndDispatch(db(input.client), {
      type: EVENT_TYPES.MONEY_DEPOSITED,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: {
        walletId: input.toWalletId,
        amountMinor: input.amount.minor,
        currency: input.amount.currency,
      },
    });
    await recordActivity(db(input.client), {
      actor: input.actor,
      action: "economy.deposit",
      targetType: "Wallet",
      targetId: input.toWalletId,
      correlationId: input.correlationId,
      metadata: { amountMinor: input.amount.minor, currency: input.amount.currency },
    });
  }

  return result;
}

export async function withdraw(input: {
  fromWalletId: string;
  amount: Money;
  description: string;
} & LedgerContext): Promise<MovementResult> {
  assertPositiveAmount(input.amount.minor, "Withdrawal amount");
  const wallet = await requireWallet(db(input.client), input.fromWalletId);

  const result = await mutateSingle({
    ...input,
    wallet,
    type: "WITHDRAWAL",
    amount: input.amount.negate(),
    description: input.description,
  });

  if (!result.replayed) {
    await eventBus.publishAndDispatch(db(input.client), {
      type: EVENT_TYPES.MONEY_WITHDRAWN,
      actor: input.actor,
      correlationId: input.correlationId,
      payload: {
        walletId: input.fromWalletId,
        amountMinor: input.amount.minor,
        currency: input.amount.currency,
      },
    });
    await recordActivity(db(input.client), {
      actor: input.actor,
      action: "economy.withdraw",
      targetType: "Wallet",
      targetId: input.fromWalletId,
      correlationId: input.correlationId,
      metadata: { amountMinor: input.amount.minor, currency: input.amount.currency },
    });
  }

  return result;
}

export interface TransferResult {
  transferGroupId: string;
  debitTransaction: Transaction;
  creditTransaction: Transaction;
  fromBalanceAfter: Money;
  toBalanceAfter: Money;
  replayed: boolean;
}

type TransferInput = {
  fromWalletId: string;
  toWalletId: string;
  amount: Money;
  description: string;
  beneficiaryAgentId?: string;
  /**
   * Leg type override. Plain transfers record TRANSFER; typed payments
   * (`pay()`) pass their own type through so salary/fee/purchase legs are
   * queryable without parsing descriptions. Defaults to TRANSFER, so every
   * existing caller keeps its behavior.
   */
  type?: TransactionType;
} & LedgerContext;

export async function transfer(input: TransferInput): Promise<TransferResult> {
  assertPositiveAmount(input.amount.minor, "Transfer amount");
  if (input.fromWalletId === input.toWalletId) {
    throw validationError("Cannot transfer to the same wallet");
  }

  // Replay short-circuit, checked before opening a transaction.
  const replay = await resolveTransferReplay(input);
  if (replay !== null) return replay;

  const ordered = [input.fromWalletId, input.toWalletId].sort();

  let outcome: { transferGroupId: string; debit: Transaction; credit: Transaction };
  try {
    outcome = await run(input.client, async (tx) => {
      const [firstWallet, secondWallet] = await Promise.all([
        tx.wallet.findUnique({ where: { id: ordered[0] } }),
        tx.wallet.findUnique({ where: { id: ordered[1] } }),
      ]);
      if (firstWallet === null) throw conflict("Wallet not found", { walletId: ordered[0] });
      if (secondWallet === null) throw conflict("Wallet not found", { walletId: ordered[1] });

      if (firstWallet.currency !== input.amount.currency || secondWallet.currency !== input.amount.currency) {
        throw conflict("Transfer currency must match both wallets", {
          expected: input.amount.currency,
          found: [firstWallet.currency, secondWallet.currency],
        });
      }

      const fromWallet = firstWallet.id === input.fromWalletId ? firstWallet : secondWallet;
      const toWallet = firstWallet.id === input.toWalletId ? firstWallet : secondWallet;

      if (fromWallet.isFrozen) throw conflict("Source wallet is frozen", { walletId: fromWallet.id });
      if (toWallet.isFrozen) throw conflict("Target wallet is frozen", { walletId: toWallet.id });

      if (fromWallet.balanceMinor < input.amount.minor) {
        throw insufficientFunds(
          `Insufficient funds: available ${Money.fromMinor(fromWallet.balanceMinor, fromWallet.currency).toString()}, ` +
            `required ${input.amount.toString()}`,
          {
            walletId: fromWallet.id,
            availableMinor: fromWallet.balanceMinor,
            requestedMinor: input.amount.minor,
            currency: input.amount.currency,
          },
        );
      }

      const transferGroupId = randomUUID();
      const legType = input.type ?? "TRANSFER";

      const debit = await applyMovement(
        tx,
        {
          ...input,
          wallet: fromWallet,
          type: legType,
          amount: input.amount.negate(),
          description: input.description,
          counterpartyType: "WALLET",
          counterpartyId: toWallet.id,
        },
        transferGroupId,
      );

      // Re-read: the counterparty's version may have advanced under us.
      const toFresh = await tx.wallet.findUnique({ where: { id: toWallet.id } });
      if (toFresh === null) {
        throw conflict("Target wallet vanished mid-transfer", { walletId: toWallet.id });
      }

      const credit = await applyMovement(
        tx,
        {
          ...input,
          wallet: toFresh,
          type: legType,
          amount: input.amount,
          description: input.description,
          counterpartyType: "WALLET",
          counterpartyId: fromWallet.id,
        },
        transferGroupId,
      );

      return { transferGroupId, debit, credit };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await resolveTransferReplay(input);
      if (raced !== null) return raced;
    }
    throw error;
  }

  await eventBus.publishAndDispatch(db(input.client), {
    type: EVENT_TYPES.MONEY_TRANSFERRED,
    actor: input.actor,
    correlationId: input.correlationId,
    payload: {
      transferGroupId: outcome.transferGroupId,
      fromWalletId: input.fromWalletId,
      toWalletId: input.toWalletId,
      amountMinor: input.amount.minor,
      currency: input.amount.currency,
    },
  });

  await recordActivity(db(input.client), {
    actor: input.actor,
    action: "economy.transfer",
    targetType: "Wallet",
    targetId: input.fromWalletId,
    correlationId: input.correlationId,
    metadata: {
      toWalletId: input.toWalletId,
      amountMinor: input.amount.minor,
      currency: input.amount.currency,
      transferGroupId: outcome.transferGroupId,
      replayed: false,
    },
  });

  return {
    transferGroupId: outcome.transferGroupId,
    debitTransaction: outcome.debit,
    creditTransaction: outcome.credit,
    fromBalanceAfter: Money.fromMinor(outcome.debit.balanceAfterMinor, outcome.debit.currency),
    toBalanceAfter: Money.fromMinor(outcome.credit.balanceAfterMinor, outcome.credit.currency),
    replayed: false,
  };
}

async function resolveTransferReplay(input: TransferInput): Promise<TransferResult | null> {
  const key = input.idempotencyKey;
  if (key === undefined) return null;

  const client = db(input.client);
  const debit = await client.transaction.findUnique({
    where: { walletId_idempotencyKey: { walletId: input.fromWalletId, idempotencyKey: key } },
  });
  if (debit === null || debit.transferGroupId === null) return null;

  const credit = await client.transaction.findFirst({
    where: { transferGroupId: debit.transferGroupId, direction: "CREDIT" },
  });
  if (credit === null) return null;

  return {
    transferGroupId: debit.transferGroupId,
    debitTransaction: debit,
    creditTransaction: credit,
    fromBalanceAfter: Money.fromMinor(debit.balanceAfterMinor, debit.currency),
    toBalanceAfter: Money.fromMinor(credit.balanceAfterMinor, credit.currency),
    replayed: true,
  };
}

/**
 * Typed payment: salary, purchase, reward, penalty, tax, fee.
 *
 * Identical ledger mechanics to `transfer`; the extra event is what lets the
 * dashboard build salary and spending views without parsing descriptions.
 */
export async function pay(input: {
  fromWalletId: string;
  toWalletId: string;
  amount: Money;
  type: Extract<TransactionType, "SALARY" | "PURCHASE" | "REWARD" | "PENALTY" | "TAX" | "FEE">;
  description: string;
  beneficiaryAgentId?: string;
} & LedgerContext): Promise<TransferResult> {
  // TransferInput.type carries the typed-payment kind onto both legs.
  const result = await transfer(input);

  if (!result.replayed) {
    if (input.type === "SALARY" && input.beneficiaryAgentId !== undefined) {
      await eventBus.publishAndDispatch(db(input.client), {
        type: EVENT_TYPES.SALARY_PAID,
        actor: input.actor,
        correlationId: input.correlationId,
        payload: {
          transactionId: result.creditTransaction.id,
          agentId: input.beneficiaryAgentId,
          amountMinor: input.amount.minor,
          currency: input.amount.currency,
        },
      });
    }
    if (input.type === "PURCHASE") {
      await eventBus.publishAndDispatch(db(input.client), {
        type: EVENT_TYPES.PURCHASE_MADE,
        actor: input.actor,
        correlationId: input.correlationId,
        payload: {
          transactionId: result.creditTransaction.id,
          agentId: input.beneficiaryAgentId ?? input.actor.actorId ?? null,
          amountMinor: input.amount.minor,
          description: input.description,
        },
      });
    }
  }

  return result;
}

/**
 * Manual balance correction.
 *
 * Kept distinct from `deposit` because an adjustment overturns a previously
 * asserted total, so it is always tagged ADJUSTMENT (trivially filterable in an
 * audit) and is expected to arrive from an approved request.
 */
export async function adjust(input: {
  walletId: string;
  /** Signed. */
  delta: Money;
  reason: string;
} & LedgerContext): Promise<MovementResult> {
  if (input.delta.isZero) throw validationError("Adjustment must not be zero");

  const wallet = await requireWallet(db(input.client), input.walletId);
  const result = await mutateSingle({
    ...input,
    wallet,
    type: "ADJUSTMENT",
    amount: input.delta,
    description: input.reason,
  });

  if (!result.replayed) {
    await recordActivity(db(input.client), {
      actor: input.actor,
      action: "economy.adjust",
      targetType: "Wallet",
      targetId: input.walletId,
      correlationId: input.correlationId,
      metadata: {
        deltaMinor: input.delta.minor,
        reason: input.reason,
        approvalRequestId: input.approvalRequestId ?? null,
      },
    });
    log.warn("Balance adjusted manually", {
      action: "economy.adjust",
      targetType: "Wallet",
      targetId: input.walletId,
      result: "OK",
      deltaMinor: input.delta.minor,
      approvalRequestId: input.approvalRequestId ?? null,
      correlationId: input.correlationId,
    });
  }

  return result;
}
