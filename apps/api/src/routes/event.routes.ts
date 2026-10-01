import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { listActivity } from "../../../../packages/events/src/audit.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { getCorrelationId } from "../middleware/correlation.js";

export const eventRouter: Router = Router();
eventRouter.use(authenticate);

eventRouter.get(
  "/events",
  requirePermission(PERMISSIONS.EVENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const events = await prisma.eventLog.findMany({
        where: {
          ...(q.type !== undefined ? { type: q.type } : {}),
          ...(q.companyId !== undefined ? { companyId: q.companyId } : {}),
          ...(q.worldId !== undefined ? { worldId: q.worldId } : {}),
          ...(q.correlationId !== undefined ? { correlationId: q.correlationId } : {}),
        },
        orderBy: { id: "desc" },
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({
        data: events.map((e) => ({ ...e, payload: JSON.parse(e.payload) })),
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

eventRouter.get(
  "/activity",
  requirePermission(PERMISSIONS.EVENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const activity = await listActivity(prisma, {
        ...(q.actorId !== undefined ? { actorId: q.actorId } : {}),
        ...(q.action !== undefined ? { action: q.action } : {}),
        ...(q.correlationId !== undefined ? { correlationId: q.correlationId } : {}),
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: activity, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
