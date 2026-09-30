/**
 * Company treasury.
 *
 * The company's money lives in an ordinary wallet whose owner is the company.
 * This service is the only sanctioned way to reach it, so "pay salaries" and
 * "pay a vendor" cannot accidentally draw on an agent's personal funds.
 *
 * Nothing here bypasses the ledger; every operation delegates to LedgerService.
 */
import { Money, validationError, notFound, type ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Company, Wallet } from "../../database/src/types.js";
import { prisma } from "../../database/src/index.js";
import { ensureWallet } from "./wallet.service.js";
import { deposit, pay, withdraw, type LedgerContext } from "./ledger.service.js";

/** The company's treasury wallet, created on first use at zero balance. */
export async function getTreasury(db: DbClient, companyId: string): Promise<Wallet> {
  return ensureWallet(db, { ownerType: "COMPANY", ownerId: companyId });
}

export async function getTreasuryBalance(
  db: DbClient,
  companyId: string,
  currency?: string,
): Promise<Money> {
  const wallet = await getTreasury(db, companyId);
  return Money.fromMinor(wallet.balanceMinor, currency ?? wallet.currency);
}

/** Capital injection from the human owner into the company's account. */
export async function fundTreasury(input: {
  companyId: string;
  amount: Money;
  description?: string;
} & LedgerContext): Promise<{ wallet: Wallet; balanceAfter: Money }> {
  assertPositive(input.amount, "Treasury funding amount");
  const wallet = await getTreasury(prisma, input.companyId);
  const result = await deposit({
    ...input,
    toWalletId: wallet.id,
    amount: input.amount,
    description: input.description ?? `Treasury funding for company ${input.companyId}`,
  });
  return { wallet, balanceAfter: result.balanceAfter };
}

/** Pays one employee from the treasury. */
export async function paySalary(input: {
  companyId: string;
  agentId: string;
  amount: Money;
  description?: string;
} & LedgerContext): Promise<{ balanceAfter: Money }> {
  assertPositive(input.amount, "Salary amount");
  const treasury = await getTreasury(prisma, input.companyId);
  const agentWallet = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: input.agentId });

  const result = await pay({
    ...input,
    fromWalletId: treasury.id,
    toWalletId: agentWallet.id,
    amount: input.amount,
    type: "SALARY",
    beneficiaryAgentId: input.agentId,
    description: input.description ?? `Salary payment to agent ${input.agentId}`,
  });
  return { balanceAfter: result.fromBalanceAfter };
}

/** Pays a vendor, shop or any other counterparty from the treasury. */
export async function payPurchase(input: {
  companyId: string;
  toWalletId: string;
  amount: Money;
  description: string;
} & LedgerContext): Promise<{ balanceAfter: Money }> {
  assertPositive(input.amount, "Purchase amount");
  const treasury = await getTreasury(prisma, input.companyId);
  const result = await pay({
    ...input,
    fromWalletId: treasury.id,
    toWalletId: input.toWalletId,
    amount: input.amount,
    type: "PURCHASE",
    description: input.description,
  });
  return { balanceAfter: result.fromBalanceAfter };
}

export async function withdrawFromTreasury(input: {
  companyId: string;
  toWalletId: string;
  amount: Money;
  description: string;
} & LedgerContext): Promise<{ balanceAfter: Money }> {
  assertPositive(input.amount, "Withdrawal amount");
  const treasury = await getTreasury(prisma, input.companyId);
  const result = await withdraw({
    ...input,
    fromWalletId: treasury.id,
    amount: input.amount,
    description: input.description,
  });
  return { balanceAfter: result.balanceAfter };
}

export interface CompanyFinanceSummary {
  company: Pick<Company, "id" | "name">;
  treasuryBalance: Money;
  totalIncomeMinor: number;
  totalExpensesMinor: number;
  currency: string;
}

/** Dashboard summary: treasury balance plus income/expense totals. */
export async function getCompanyFinance(
  db: DbClient,
  companyId: string,
): Promise<CompanyFinanceSummary> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true },
  });
  if (company === null) throw notFound("Company", companyId);

  const treasury = await getTreasury(db, companyId);

  const byDirection = await db.transaction.groupBy({
    by: ["direction"],
    where: { walletId: treasury.id },
    _sum: { amountMinor: true },
  });

  const incomeMinor = byDirection.find((row) => row.direction === "CREDIT")?._sum.amountMinor ?? 0;
  const expensesMinor = byDirection.find((row) => row.direction === "DEBIT")?._sum.amountMinor ?? 0;

  return {
    company,
    treasuryBalance: Money.fromMinor(treasury.balanceMinor, treasury.currency),
    totalIncomeMinor: incomeMinor,
    totalExpensesMinor: expensesMinor,
    currency: treasury.currency,
  };
}

function assertPositive(amount: Money, label: string): void {
  if (!amount.isPositive) {
    throw validationError(`${label} must be greater than zero`, { amount: amount.toString() });
  }
}

export type { ActorRef };
