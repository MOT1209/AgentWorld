import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  finishSession,
  getSession,
  listSessions,
  startSession,
} from "../../../../packages/runtime/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";

export const sessionRouter: Router = Router();
sessionRouter.use(authenticate);

sessionRouter.get(
  "/",
  requirePermission(PERMISSIONS.SESSION_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const sessions = await listSessions(prisma, {
        ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
        ...(q.taskId !== undefined ? { taskId: q.taskId } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: { items: sessions }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

sessionRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.SESSION_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const session = await getSession(prisma, req.params.id as string);
      res.json({ data: { session }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const StartSessionSchema = z.object({
  agentId: z.string().min(1),
  providerId: z.string().min(1).max(80).optional(),
  model: z.string().min(1).max(120).optional(),
  taskId: z.string().min(1).optional(),
  trigger: z.enum(["CHAT", "TASK_ASSIGNED", "SCHEDULED", "MANUAL"]).default("MANUAL"),
  context: z.record(z.string(), z.unknown()).optional(),
});

sessionRouter.post(
  "/",
  requirePermission(PERMISSIONS.SESSION_START),
  validate("body", StartSessionSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof StartSessionSchema>;
      const session = await startSession(
        prisma,
        {
          agentId: body.agentId,
          ...(body.providerId !== undefined ? { providerId: body.providerId } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
          trigger: body.trigger,
          ...(body.context !== undefined ? { context: body.context } : {}),
        },
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
      );
      res.status(201).json({ data: { session }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const FinishSessionSchema = z.object({
  status: z.enum(["COMPLETED", "FAILED", "CANCELLED"]),
  result: z.string().max(5000).optional().nullable(),
  error: z.string().max(2000).optional().nullable(),
});

sessionRouter.post(
  "/:id/finish",
  requirePermission(PERMISSIONS.SESSION_START),
  validate("body", FinishSessionSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof FinishSessionSchema>;
      const session = await finishSession(
        prisma,
        req.params.id as string,
        {
          status: body.status,
          ...(body.result !== undefined ? { result: body.result } : {}),
          ...(body.error !== undefined ? { error: body.error } : {}),
        },
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
      );
      res.json({ data: { session }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
