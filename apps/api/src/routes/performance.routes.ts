/**
 * Performance Center REST.
 *
 * All numbers are computed from recorded history (tasks, reviews, executions,
 * AI usage) on request -- nothing is cached or hand-edited. `since` bounds the
 * window; omit it for all-time.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { agentPerformance, companyPerformance } from "../../../../packages/agents/src/index.js";
import { validationError } from "../../../../packages/shared/src/index.js";

export const performanceRouter = Router();

performanceRouter.use(authenticate, requirePermission(PERMISSIONS.AGENT_READ));

performanceRouter.get(
  "/agents/:agentId",
  async (req: Request, res: Response, _next: NextFunction) => {
    const since = parseSince(req.query.since as string | undefined);
    const summary = await agentPerformance(prisma, req.params.agentId as string, { since });
    res.json({ data: summary });
  },
);

performanceRouter.get(
  "/companies/:companyId",
  async (req: Request, res: Response, _next: NextFunction) => {
    const since = parseSince(req.query.since as string | undefined);
    const summary = await companyPerformance(prisma, req.params.companyId as string, { since });
    res.json({ data: summary });
  },
);

function parseSince(raw: string | undefined): Date | undefined {
  if (raw === undefined || raw === "") return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw validationError("since must be an ISO date");
  return date;
}
