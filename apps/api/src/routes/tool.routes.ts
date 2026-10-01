import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { getProviderRegistry } from "../../../../packages/ai/src/index.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { toolRegistry } from "../services/composition-root.js";

export const toolRouter: Router = Router();
toolRouter.use(authenticate);

toolRouter.get(
  "/catalogue",
  requirePermission(PERMISSIONS.AGENT_READ),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      res.json({ data: toolRegistry.catalogue(), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

toolRouter.get(
  "/invocations",
  requirePermission(PERMISSIONS.EVENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const invocations = await prisma.toolInvocation.findMany({
        where: {
          ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
          ...(q.toolName !== undefined ? { toolName: q.toolName } : {}),
          ...(q.status !== undefined ? { status: q.status } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: invocations, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

toolRouter.get(
  "/providers",
  requirePermission(PERMISSIONS.AGENT_READ),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      res.json({ data: getProviderRegistry().list(), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
