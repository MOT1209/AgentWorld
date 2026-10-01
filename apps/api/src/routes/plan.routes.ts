import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  getPlan,
  listPlans,
  approvePlan,
  allowedPlanTransitions,
} from "../../../../packages/orchestration/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";

export const planRouter: Router = Router();
planRouter.use(authenticate);

planRouter.get(
  "/",
  requirePermission(PERMISSIONS.PLAN_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const plans = await listPlans(prisma, {
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.companyId !== undefined ? { companyId: q.companyId } : {}),
        ...(q.createdByAgentId !== undefined ? { createdByAgentId: q.createdByAgentId } : {}),
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: { items: plans }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

planRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.PLAN_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const plan = await getPlan(prisma, req.params.id as string);
      res.json({
        data: { plan, allowedTransitions: allowedPlanTransitions(plan.status) },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Human sign-off. `plan.approve` is a human-only permission: no agent role
 * holds it, and the service re-checks anyway. This endpoint is deliberately
 * not exposed as a tool.
 */
planRouter.post(
  "/:id/approve",
  requirePermission(PERMISSIONS.PLAN_APPROVE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const plan = await approvePlan(
        prisma,
        req.params.id as string,
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
      );
      res.json({ data: { plan }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
