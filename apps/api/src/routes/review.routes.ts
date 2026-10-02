import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { getReview, listReviews, submitReview } from "../../../../packages/orchestration/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";

export const reviewRouter: Router = Router();
reviewRouter.use(authenticate);

const SubmitReviewSchema = z.object({
  taskId: z.string().min(1),
  outcome: z.enum(["APPROVED", "NEEDS_CHANGES", "REJECTED", "ESCALATE"]),
  notes: z.string().min(10).max(5000),
  criteria: z
    .array(z.object({ criterion: z.string().min(1).max(200), met: z.boolean(), note: z.string().max(500).optional() }))
    .max(25)
    .optional(),
  attempt: z.number().int().min(1).max(100).optional(),
});

reviewRouter.post(
  "/",
  requirePermission(PERMISSIONS.TASK_REVIEW),
  validate("body", SubmitReviewSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof SubmitReviewSchema>;
      const { review, task } = await submitReview(
        prisma,
        {
          taskId: body.taskId,
          outcome: body.outcome,
          notes: body.notes,
          ...(body.criteria !== undefined ? { criteria: body.criteria } : {}),
          ...(body.attempt !== undefined ? { attempt: body.attempt } : {}),
        },
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
      );
      res.status(201).json({ data: { review, taskStatus: task.status }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

reviewRouter.get(
  "/task/:taskId",
  requirePermission(PERMISSIONS.TASK_REVIEW),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reviews = await listReviews(prisma, req.params.taskId as string);
      res.json({ data: { items: reviews }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

reviewRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.TASK_REVIEW),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const review = await getReview(prisma, req.params.id as string);
      res.json({ data: { review }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
