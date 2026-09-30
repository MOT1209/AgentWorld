export {
  ensureWallet,
  requireWallet,
  requireWalletByAddress,
  listWallets,
  setWalletFrozen,
  assertPositiveAmount,
  addressKey,
  type WalletAddress,
  type WalletWithOwner,
} from "./wallet.service.js";

export {
  deposit,
  withdraw,
  transfer,
  pay,
  adjust,
  type LedgerContext,
  type MovementResult,
  type TransferResult,
} from "./ledger.service.js";

export {
  getStatement,
  getLedgerTotals,
  verifyLedger,
  computeNetCirculation,
  assertWalletCurrency,
  type Statement,
  type StatementEntry,
  type StatementQuery,
  type LedgerTotals,
  type LedgerIntegrityReport,
  type WalletIntegrity,
} from "./statements.js";

export {
  getTreasury,
  getTreasuryBalance,
  getCompanyFinance,
  fundTreasury,
  paySalary,
  payPurchase,
  withdrawFromTreasury,
  type CompanyFinanceSummary,
} from "./treasury.service.js";
