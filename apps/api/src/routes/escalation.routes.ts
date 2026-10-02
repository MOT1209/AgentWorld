import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  acknowledgeEscalation,
  listEscalations,
  listHumanEscalations,
  raiseEscalation,
  requireEscalation,
  resolveEscalation,
} from "../../../../packages/orchestration/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";

export const escalationRouter: Router = Router();
escalationRouter.use(authenticate);

const RaiseEscalationSchema = z.object({
  fromAgentId: z.string().min(1),
  category: z.enum([
    "BLOCKED",
    "TOOL_UNAVAILABLE",
    "TASK_IMPOSSIBLE",
    "APPROVAL_REQUIRED",
    "REPEATED_FAILURE",
    "PERMISSION_DENIED",
    "MISSING_INFORMATION",
  ]),
  detail: z.string().min(10).max(5000),
  taskId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  approvalRequestId: z.string().min(1).optional(),
  toAgentId: z.string().min(1).optional(),
  toUserId: z.string().min(1).optional(),
});

escalationRouter.post(
  "/",
  requirePermission(PERMISSIONS.ESCALATE),
  validate("body", RaiseEscalationSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof RaiseEscalationSchema>;
      const escalation = await raiseEscalation(
        prisma,
        {
          fromAgentId: body.fromAgentId,
          category: body.category,
          detail: body.detail,
          ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
          ...(body.planId !== undefined ? { planId: body.planId } : {}),
          ...(body.approvalRequestId !== undefined ? { approvalRequestId: body.approvalRequestId } : {}),
          ...(body.toAgentId !== undefined ? { toAgentId: body.toAgentId } : {}),
          ...(body.toUserId !== undefined ? { toUserId: body.toUserId } : {}),
        },
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
      );
      res.status(201).json({ data: { escalation }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

escalationRouter.get(
  "/",
  requirePermission(PERMISSIONS.ESCALATE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const escalations = await listEscalations(prisma, {
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.fromAgentId !== undefined ? { fromAgentId: q.fromAgentId } : {}),
        ...(q.toAgentId !== undefined ? { toAgentId: q.toAgentId } : {}),
        ...(q.category !== undefined ? { category: q.category } : {}),
        ...(q.taskId !== undefined ? { taskId: q.taskId } : {}),
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: { items: escalations }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

/** The King's queue: open escalations routed to no agent. */
escalationRouter.get(
  "/human",
  requirePermission(PERMISSIONS.ESCALATE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const escalations = await listHumanEscalations(prisma);
      res.json({ data: { items: escalations }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

escalationRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.ESCALATE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const escalation = await requireEscalation(prisma, req.params.id as string);
      res.json({ data: { escalation }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

escalationRouter.post(
  "/:id/ack",
  requirePermission(PERMISSIONS.ESCALATE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const escalation = await acknowledgeEscalation(prisma, req.params.id as string, {
        actor: principalToActor(principal),
        permissions: principal.permissions,
        userId: principal.userId,
        correlationId: getCorrelationId(req),
      });
      res.json({ data: { escalation }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const ResolveEscalationSchema = z.object({
  outcome: z.enum(["RESOLVED", "REJECTED"]),
  resolution: z.string().min(5).max(2000),
});

escalationRouter.post(
  "/:id/resolve",
  requirePermission(PERMISSIONS.ESCALATE),
  validate("body", ResolveEscalationSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof ResolveEscalationSchema>;
      const escalation = await resolveEscalation(
        prisma,
        { escalationId: req.params.id as string, outcome: body.outcome, resolution: body.resolution },
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
      );
      res.json({ data: { escalation }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
