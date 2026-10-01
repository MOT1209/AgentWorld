import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  listApprovals,
  getApproval,
  decideApproval,
  countPendingApprovals,
  expireStaleApprovals,
} from "../../../../packages/approvals/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { toApprovalDto } from "../dto/index.js";
import { replayApprovedRequest } from "../services/approval-replay.js";

export const approvalRouter: Router = Router();
approvalRouter.use(authenticate);

approvalRouter.get(
  "/",
  requirePermission(PERMISSIONS.APPROVAL_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      await expireStaleApprovals(prisma).catch(() => undefined);
      const approvals = await listApprovals(prisma, {
        ...(q.status !== undefined ? { status: q.status.split(",").map((s) => s.trim()).filter(Boolean) as never } : {}),
        ...(q.requesterAgentId !== undefined ? { requesterAgentId: q.requesterAgentId } : {}),
        ...(q.companyId !== undefined ? { companyId: q.companyId } : {}),
        ...(q.risk !== undefined ? { risk: q.risk as never } : {}),
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      const pending = await countPendingApprovals(prisma);
      res.json({
        data: {
          items: approvals.map((a) => toApprovalDto(a as unknown as Record<string, unknown>)),
          pending,
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

approvalRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.APPROVAL_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const approval = await getApproval(prisma, req.params.id as string);
      res.json({ data: toApprovalDto(approval as unknown as Record<string, unknown>), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const DecideSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(1000).optional(),
  replay: z.boolean().default(true),
});

approvalRouter.post(
  "/:id/decision",
  requirePermission(PERMISSIONS.APPROVAL_DECIDE),
  validate("body", DecideSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof DecideSchema>;
      const decided = await decideApproval(
        prisma,
        {
          requestId: req.params.id as string,
          decision: body.decision,
          note: body.note,
          decidedByUserId: principal.userId,
          decidedByName: principal.displayName,
        },
        {
          actor: principalToActor(principal),
          correlationId: getCorrelationId(req),
          permissions: principal.permissions,
          userId: principal.userId,
          ip: req.ip ?? null,
          userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
        },
      );

      let replay: unknown = null;
      if (body.decision === "APPROVED" && body.replay) {
        replay = await replayApprovedRequest(decided.id, req);
      }

      res.json({
        data: { approval: toApprovalDto(decided as unknown as Record<string, unknown>), replay },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);
