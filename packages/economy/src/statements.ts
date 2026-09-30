/**
 * Ledger queries: statements, aggregates, and the integrity self-check.
 *
 * `verifyLedger` exists so "the books balance" is a thing the test suite can
 * assert rather than a claim in a document. It replays every transaction per
 * wallet and compares the result to the stored balance and to the recorded
 * `balanceAfterMinor` of each entry.
 */
import { Money, validationError } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Transaction, Wallet } from "../../database/src/types.js";

export interface StatementEntry {
  id: string;
  type: string;
  direction: string;
  amountMinor: number;
  signedMinor: number;
  balanceAfterMinor: number;
  currency: string;
  description: string | null;
  counterpartyType: string | null;
  counterpartyId: string | null;
  actorType: string;
  actorId: string | null;
  transferGroupId: string | null;
  createdAt: Date;
}

export interface Statement {
  walletId: string;
  ownerType: string;
  ownerId: string;
  currency: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  entries: StatementEntry[];
  totalCreditedMinor: number;
  totalDebitedMinor: number;
}

function toEntry(transaction: Transaction): StatementEntry {
  const signed =
    transaction.direction === "CREDIT" ? transaction.amountMinor : -transaction.amountMinor;
  return {
    id: transaction.id,
    type: transaction.type,
    direction: transaction.direction,
    amountMinor: transaction.amountMinor,
    signedMinor: signed,
    balanceAfterMinor: transaction.balanceAfterMinor,
    currency: transaction.currency,
    description: transaction.description,
    counterpartyType: transaction.counterpartyType,
    counterpartyId: transaction.counterpartyId,
    actorType: transaction.actorType,
    actorId: transaction.actorId,
    transferGroupId: transaction.transferGroupId,
    createdAt: transaction.createdAt,
  };
}

export interface StatementQuery {
  ownerType?: string;
  ownerId?: string;
  walletId?: string;
  currency?: string;
  type?: string;
  since?: Date;
  limit?: number;
}

export async function getStatement(
  db: DbClient,
  query: StatementQuery,
): Promise<Statement[]> {
  const wallets: Wallet[] = await db.wallet.findMany({
    where: {
      ...(query.walletId !== undefined ? { id: query.walletId } : {}),
      ...(query.ownerType !== undefined ? { ownerType: query.ownerType } : {}),
      ...(query.ownerId !== undefined ? { ownerId: query.ownerId } : {}),
      ...(query.currency !== undefined ? { currency: query.currency } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  return Promise.all(
    wallets.map(async (wallet) => {
      const transactions = await db.transaction.findMany({
        where: {
          walletId: wallet.id,
          ...(query.type !== undefined ? { type: query.type } : {}),
          ...(query.since !== undefined ? { createdAt: { gte: query.since } } : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: query.limit ?? 200,
      });

      const entries = transactions.map(toEntry);
      const totalCreditedMinor = entries
        .filter((entry) => entry.direction === "CREDIT")
        .reduce((sum, entry) => sum + entry.amountMinor, 0);
      const totalDebitedMinor = entries
        .filter((entry) => entry.direction === "DEBIT")
        .reduce((sum, entry) => sum + entry.amountMinor, 0);
      const openingBalanceMinor =
        (entries[0]?.balanceAfterMinor ?? wallet.balanceMinor) -
        (entries[0]?.signedMinor ?? 0);

      return {
        walletId: wallet.id,
        ownerType: wallet.ownerType,
        ownerId: wallet.ownerId,
        currency: wallet.currency,
        openingBalanceMinor,
        closingBalanceMinor: wallet.balanceMinor,
        entries,
        totalCreditedMinor,
        totalDebitedMinor,
      };
    }),
  );
}

export interface LedgerTotals {
  currency: string;
  totalCreditedMinor: number;
  totalDebitedMinor: number;
  netMinor: number;
  transactionCount: number;
  byType: Record<string, number>;
}

export async function getLedgerTotals(
  db: DbClient,
  currency?: string,
): Promise<LedgerTotals> {
  const grouped = await db.transaction.groupBy({
    by: ["currency", "direction", "type"],
    where: currency !== undefined ? { currency } : {},
    _sum: { amountMinor: true },
    _count: { _all: true },
  });

  const byType: Record<string, number> = {};
  let totalCreditedMinor = 0;
  let totalDebitedMinor = 0;
  let transactionCount = 0;
  let resolvedCurrency = currency ?? "KW";

  for (const row of grouped) {
    const amount = row._sum.amountMinor ?? 0;
    byType[row.type] = (byType[row.type] ?? 0) + amount;
    resolvedCurrency = row.currency;
    transactionCount += row._count._all;
    if (row.direction === "CREDIT") totalCreditedMinor += amount;
    else totalDebitedMinor += amount;
  }

  return {
    currency: resolvedCurrency,
    totalCreditedMinor,
    totalDebitedMinor,
    netMinor: totalCreditedMinor - totalDebitedMinor,
    transactionCount,
    byType,
  };
}

// =============================================================================
// INTEGRITY
// =============================================================================

export interface WalletIntegrity {
  walletId: string;
  ownerType: string;
  ownerId: string;
  storedBalanceMinor: number;
  replayedBalanceMinor: number;
  ok: boolean
  /** Entries whose recorded balanceAfter disagrees with the replay. */
  chainBreaks: Array<{ transactionId: string; expected: number; recorded: number }>;
}

export interface LedgerIntegrityReport {
  ok: boolean;
  checkedWallets: number;
  checkedTransactions: number;
  problems: WalletIntegrity[];
}

/**
 * Replays the ledger for every wallet and proves:
 *   - the stored balance equals the sum of its entries, and
 *   - every entry's recorded balanceAfter matches the running total.
 *
 * This is the property that makes the economy trustworthy. It runs in the test
 * suite after every financial scenario.
 */
export async function verifyLedger(
  db: DbClient,
  walletIds?: string[],
): Promise<LedgerIntegrityReport> {
  const wallets = await db.wallet.findMany({
    where: walletIds !== undefined ? { id: { in: walletIds } } : {},
    orderBy: { id: "asc" },
  });

  const problems: WalletIntegrity[] = [];
  let checkedTransactions = 0;

  for (const wallet of wallets) {
    const transactions = await db.transaction.findMany({
      where: { walletId: wallet.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    checkedTransactions += transactions.length;

    let running = 0;
    const chainBreaks: WalletIntegrity["chainBreaks"] = [];

    for (const transaction of transactions) {
      running += transaction.direction === "CREDIT" ? transaction.amountMinor : -transaction.amountMinor;
      if (running !== transaction.balanceAfterMinor) {
        chainBreaks.push({
          transactionId: transaction.id,
          expected: running,
          recorded: transaction.balanceAfterMinor,
        });
      }
      if (running < 0) {
        chainBreaks.push({
          transactionId: transaction.id,
          expected: 0,
          recorded: transaction.balanceAfterMinor,
        });
      }
    }

    const ok = running === wallet.balanceMinor && chainBreaks.length === 0;
    if (!ok) {
      problems.push({
        walletId: wallet.id,
        ownerType: wallet.ownerType,
        ownerId: wallet.ownerId,
        storedBalanceMinor: wallet.balanceMinor,
        replayedBalanceMinor: running,
        ok,
        chainBreaks,
      });
    }
  }

  return {
    ok: problems.length === 0,
    checkedWallets: wallets.length,
    checkedTransactions,
    problems,
  };
}

/** Money moved in, minus money moved out, across the whole economy. */
export async function computeNetCirculation(db: DbClient): Promise<Money> {
  const wallets = await db.wallet.findMany();
  const net = wallets.reduce((sum, wallet) => sum + wallet.balanceMinor, 0);
  const currency = wallets[0]?.currency ?? "KW";
  return Money.fromMinor(net, currency);
}

export async function assertWalletCurrency(wallet: Wallet, expected: string): Promise<void> {
  if (wallet.currency !== expected) {
    throw validationError(
      `Wallet currency ${wallet.currency} does not match expected ${expected}`,
      { walletId: wallet.id },
    );
  }
}
