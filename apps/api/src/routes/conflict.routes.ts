import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  listConflicts,
  raiseConflict,
  requireConflict,
  resolveConflict,
} from "../../../../packages/orchestration/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";

export const conflictRouter: Router = Router();
conflictRouter.use(authenticate);

const participantSchema = z.object({
  agentId: z.string().min(1),
  position: z.string().min(1).max(2000),
  evidence: z.string().max(2000).optional(),
});

const RaiseConflictSchema = z.object({
  issue: z.string().min(5).max(2000),
  participants: z.array(participantSchema).min(2).max(20),
  positions: z.record(z.string(), z.unknown()).optional(),
  evidence: z.string().max(5000).optional().nullable(),
  taskId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  status: z.enum(["OPEN", "DISCUSSING"]).optional(),
});

conflictRouter.post(
  "/",
  requirePermission(PERMISSIONS.TASK_REVIEW),
  validate("body", RaiseConflictSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof RaiseConflictSchema>;
      const conflict = await raiseConflict(
        prisma,
        {
          issue: body.issue,
          participants: body.participants,
          ...(body.positions !== undefined ? { positions: body.positions } : {}),
          ...(body.evidence !== undefined ? { evidence: body.evidence } : {}),
          ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
          ...(body.planId !== undefined ? { planId: body.planId } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        },
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
      );
      res.status(201).json({ data: { conflict }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

conflictRouter.get(
  "/",
  requirePermission(PERMISSIONS.TASK_REVIEW),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const conflicts = await listConflicts(prisma, {
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.taskId !== undefined ? { taskId: q.taskId } : {}),
        ...(q.planId !== undefined ? { planId: q.planId } : {}),
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
      });
      res.json({ data: { items: conflicts }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

conflictRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.TASK_REVIEW),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const conflict = await requireConflict(prisma, req.params.id as string);
      res.json({ data: { conflict }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const ResolveConflictSchema = z.object({
  resolution: z.string().min(5).max(5000),
  decision: z.string().min(1).max(60),
});

conflictRouter.post(
  "/:id/resolve",
  requirePermission(PERMISSIONS.TASK_REVIEW),
  validate("body", ResolveConflictSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof ResolveConflictSchema>;
      const conflict = await resolveConflict(
        prisma,
        { conflictId: req.params.id as string, resolution: body.resolution, decision: body.decision },
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
      );
      res.json({ data: { conflict }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
