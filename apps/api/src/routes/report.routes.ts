import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { getReport, listReports, writeReport } from "../../../../packages/orchestration/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";

export const reportRouter: Router = Router();
reportRouter.use(authenticate);

const WriteReportSchema = z.object({
  kind: z.enum(["PROGRESS", "TASK", "EXECUTION", "REVIEW", "ERROR"]),
  summary: z.string().min(1).max(2000),
  payload: z.record(z.string(), z.unknown()).optional(),
  taskId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
});

reportRouter.post(
  "/",
  requirePermission(PERMISSIONS.REPORT_CREATE),
  validate("body", WriteReportSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof WriteReportSchema>;
      const report = await writeReport(
        prisma,
        {
          kind: body.kind,
          summary: body.summary,
          ...(body.payload !== undefined ? { payload: body.payload } : {}),
          ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
          ...(body.planId !== undefined ? { planId: body.planId } : {}),
          ...(body.conversationId !== undefined ? { conversationId: body.conversationId } : {}),
        },
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
      );
      res.status(201).json({ data: { report }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

reportRouter.get(
  "/",
  requirePermission(PERMISSIONS.REPORT_CREATE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const reports = await listReports(prisma, {
        ...(q.taskId !== undefined ? { taskId: q.taskId } : {}),
        ...(q.planId !== undefined ? { planId: q.planId } : {}),
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: { items: reports }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

reportRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.REPORT_CREATE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const report = await getReport(prisma, req.params.id as string);
      res.json({ data: { report }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
