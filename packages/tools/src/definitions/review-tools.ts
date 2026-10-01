/**
 * Review tools.
 *
 * `review.submit` is how a reviewer judges REVIEWING work. The service — not
 * the tool — enforces the self-review ban, the rework budget, and the
 * review-to-escalation wiring.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { submitReview } from "../../../orchestration/src/index.js";
import type { ToolDefinition } from "../types.js";

const criterionSchema = z.object({
  criterion: z.string().min(1).max(200),
  met: z.boolean(),
  note: z.string().max(500).optional(),
});

export const reviewSubmitTool: ToolDefinition<{
  taskId: string;
  outcome: "APPROVED" | "NEEDS_CHANGES" | "REJECTED" | "ESCALATE";
  notes: string;
  criteria?: Array<{ criterion: string; met: boolean; note?: string }>;
  attempt?: number;
}> = {
  name: "review.submit",
  description:
    "Judge a task in REVIEWING. APPROVED completes it, NEEDS_CHANGES sends it " +
    "back (bounded by retries), REJECTED fails it, ESCALATE blocks it and raises. " +
    "You may not review your own work.",
  inputSchema: z.object({
    taskId: z.string(),
    outcome: z.enum(["APPROVED", "NEEDS_CHANGES", "REJECTED", "ESCALATE"]),
    notes: z.string().min(10).max(5000),
    criteria: z.array(criterionSchema).max(25).optional(),
    attempt: z.number().int().min(1).max(100).optional(),
  }),
  requiredPermission: PERMISSIONS.TASK_REVIEW,
  risk: "LOW",
  async execute(context, input) {
    const { review, task } = await submitReview(
      context.db,
      {
        taskId: input.taskId,
        outcome: input.outcome,
        notes: input.notes,
        ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      },
      {
        actor: context.actor,
        correlationId: context.correlationId,
        permissions: context.permissions,
        ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
        ...(context.actor.actorType === "USER" && context.actor.actorId !== undefined
          ? { userId: context.actor.actorId }
          : {}),
        ...(context.companyId !== undefined ? { companyId: context.companyId } : {}),
        ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
      },
    );
    return {
      data: { reviewId: review.id, outcome: review.outcome, taskId: task.id, taskStatus: task.status },
      summary: `Review ${review.outcome}: task ${task.id} is now ${task.status}`,
    };
  },
};

export const reviewTools = [reviewSubmitTool];
