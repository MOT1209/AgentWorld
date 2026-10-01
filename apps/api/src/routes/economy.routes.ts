import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  listWallets,
  requireWallet,
  ensureWallet,
  setWalletFrozen,
} from "../../../../packages/economy/src/wallet.service.js";
import { deposit, withdraw, transfer } from "../../../../packages/economy/src/ledger.service.js";
import { getStatement, getLedgerTotals, verifyLedger } from "../../../../packages/economy/src/statements.js";
import {
  getTreasuryBalance,
  getCompanyFinance,
  fundTreasury,
  paySalary,
} from "../../../../packages/economy/src/treasury.service.js";
import { Money } from "../../../../packages/shared/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { newCorrelationId } from "../../../../packages/shared/src/index.js";

export const economyRouter: Router = Router();
economyRouter.use(authenticate);

economyRouter.get(
  "/wallets",
  requirePermission(PERMISSIONS.WALLET_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const wallets = await listWallets(prisma);
      res.json({ data: wallets, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.get(
  "/wallets/:id",
  requirePermission(PERMISSIONS.WALLET_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const wallet = await requireWallet(prisma, req.params.id as string);
      res.json({ data: wallet, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.get(
  "/statement",
  requirePermission(PERMISSIONS.TRANSACTION_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const statements = await getStatement(prisma, {
        ...(q.walletId !== undefined ? { walletId: q.walletId } : {}),
        ...(q.ownerType !== undefined ? { ownerType: q.ownerType } : {}),
        ...(q.ownerId !== undefined ? { ownerId: q.ownerId } : {}),
        ...(q.currency !== undefined ? { currency: q.currency } : {}),
        ...(q.type !== undefined ? { type: q.type } : {}),
        limit: q.limit !== undefined ? Math.min(100, Number(q.limit) || 20) : 20,
      });
      res.json({ data: statements, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.get(
  "/totals",
  requirePermission(PERMISSIONS.TRANSACTION_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const totals = await getLedgerTotals(prisma, q.currency ?? "KW");
      res.json({ data: totals, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.get(
  "/verify",
  requirePermission(PERMISSIONS.TRANSACTION_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const report = await verifyLedger(prisma);
      res.json({ data: report, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const AmountSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "amount must be a decimal like 12.50"),
  currency: z.string().min(1).max(10).default("KW"),
  description: z.string().max(500).default("API transfer"),
  idempotencyKey: z.string().max(120).optional(),
});

economyRouter.post(
  "/transfer",
  requirePermission(PERMISSIONS.WALLET_TRANSFER),
  validate("body", AmountSchema.extend({ fromWalletId: z.string().min(1), toWalletId: z.string().min(1) })),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof AmountSchema> & { fromWalletId: string; toWalletId: string };
      const result = await transfer(
        {
          fromWalletId: body.fromWalletId,
          toWalletId: body.toWalletId,
          amount: Money.fromMajor(body.amount, body.currency),
          description: body.description,
          actor: principalToActor(principal),
          correlationId: getCorrelationId(req),
          ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : { idempotencyKey: newCorrelationId() }),
        },
      );
      res.json({ data: result, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.post(
  "/deposit",
  requirePermission(PERMISSIONS.WALLET_TRANSFER),
  validate("body", AmountSchema.extend({ toWalletId: z.string().min(1) })),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof AmountSchema> & { toWalletId: string };
      const result = await deposit({
        toWalletId: body.toWalletId,
        amount: Money.fromMajor(body.amount, body.currency),
        description: body.description,
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: result, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.post(
  "/withdraw",
  requirePermission(PERMISSIONS.WALLET_WITHDRAW),
  validate("body", AmountSchema.extend({ fromWalletId: z.string().min(1) })),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof AmountSchema> & { fromWalletId: string };
      const result = await withdraw({
        fromWalletId: body.fromWalletId,
        amount: Money.fromMajor(body.amount, body.currency),
        description: body.description,
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: result, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.post(
  "/wallets/ensure",
  requirePermission(PERMISSIONS.WALLET_TRANSFER),
  validate("body", z.object({ ownerType: z.enum(["AGENT", "USER", "COMPANY"]), ownerId: z.string().min(1), currency: z.string().min(1).max(10).default("KW") })),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as { ownerType: "AGENT" | "USER" | "COMPANY"; ownerId: string; currency: string };
      const wallet = await ensureWallet(prisma, body);
      res.status(201).json({ data: wallet, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.post(
  "/wallets/:id/freeze",
  requirePermission(PERMISSIONS.WALLET_WITHDRAW),
  validate("body", z.object({ frozen: z.boolean() })),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as { frozen: boolean };
      const wallet = await setWalletFrozen(prisma, req.params.id as string, body.frozen);
      res.json({ data: wallet, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.get(
  "/treasury/:companyId",
  requirePermission(PERMISSIONS.COMPANY_TREASURY_VIEW),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const balance = await getTreasuryBalance(prisma, req.params.companyId as string, q.currency ?? "KW");
      const finance = await getCompanyFinance(prisma, req.params.companyId as string);
      res.json({
        data: { balanceMinor: balance.minor, currency: balance.currency, summary: finance },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

economyRouter.post(
  "/treasury/:companyId/fund",
  requirePermission(PERMISSIONS.WALLET_TRANSFER),
  validate("body", AmountSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof AmountSchema>;
      const result = await fundTreasury({
        companyId: req.params.companyId as string,
        amount: Money.fromMajor(body.amount, body.currency),
        description: body.description,
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: result, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const SalarySchema = z.object({
  agentId: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().min(1).max(10).default("KW"),
  description: z.string().max(500).optional(),
});

economyRouter.post(
  "/treasury/:companyId/salary",
  requirePermission(PERMISSIONS.WALLET_TRANSFER),
  validate("body", SalarySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof SalarySchema>;
      const result = await paySalary({
        companyId: req.params.companyId as string,
        agentId: body.agentId,
        amount: Money.fromMajor(body.amount, body.currency),
        description: body.description,
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: result, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
