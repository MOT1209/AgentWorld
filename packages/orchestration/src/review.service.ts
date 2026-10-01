/**
 * Review service â€” the gate between execution and completion.
 *
 * Rules enforced here (not in the tool layer):
 *  - Self-review ban: an agent may not review its own or its created work.
 *  - Only REVIEWING tasks can be judged non-positively; COMPLETED tasks can
 *    only be formally approved (already-landed work, audit trail).
 *  - NEEDS_CHANGES spends a rework token (maxRetries); exceeding it fails the
 *    task and auto-raises a REPEATED_FAILURE escalation to the supervisor.
 *  - REJECTED fails the task outright. ESCALATE blocks it and raises.
 */
import {
  ReviewOutcomeSchema,
  conflict,
  forbidden,
  newCorrelationId,
  notFound,
  validationError,
} from "../../shared/src/index.js";
import type { ActorRef } from "../../shared/src/index.js";
import { actorSystem } from "../../shared/src/actor.js";
import type { DbClient } from "../../database/src/index.js";
import type { Task, TaskReview } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";
import { toJson } from "../../shared/src/json.js";
import {
  requireTask,
  updateTask,
  type TaskActorContext,
} from "../../tasks/src/task.service.js";
import { raiseEscalation, type EscalationActorContext } from "./escalation.service.js";

export interface ReviewActorContext extends TaskActorContext {
  userId?: string;
}

export interface ReviewCriterion {
  criterion: string;
  met: boolean;
  note?: string;
}

export interface SubmitReviewInput {
  taskId: string;
  outcome: string;
  notes: string;
  criteria?: ReviewCriterion[];
  /** 1-based attempt judged; defaults to the task's current attempt count. */
  attempt?: number;
}

function has(ctx: ReviewActorContext, permission: Permission): boolean {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.permissions === undefined) return true;
  return ctx.permissions.has(permission);
}

export async function submitReview(
  db: DbClient,
  input: SubmitReviewInput,
  ctx: ReviewActorContext,
): Promise<{ review: TaskReview; task: Task }> {
  if (!has(ctx, PERMISSIONS.TASK_REVIEW)) {
    throw forbidden("Caller lacks 'task.review'");
  }

  const outcome = ReviewOutcomeSchema.parse(input.outcome);
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  if (notes.length < 10) {
    throw validationError("Review notes must say why (at least 10 characters)");
  }

  const task = await requireTask(db, input.taskId);

  if (task.status === "REVIEWING" || task.status === "COMPLETED") {
    // reviewable
  } else {
    throw conflict("Task is not awaiting review", { taskId: task.id, status: task.status });
  }

  // Self-review guard: nobody judges their own work (SYSTEM exempt).
  if (ctx.actor.actorType !== "SYSTEM" && ctx.agentId !== undefined) {
    const isAssignee = task.assigneeAgentId === ctx.agentId;
    const isCreator = task.creatorAgentId === ctx.agentId;
    if (isAssignee || isCreator) {
      throw forbidden("Agents may not review their own work", {
        taskId: task.id,
        agentId: ctx.agentId,
      });
    }
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const attempt = input.attempt ?? Math.max(task.attempts, 1);

  // Non-approving verdicts require REVIEWING. Checked before the row is
  // written: a rejected judgment must not leave a phantom review behind.
  if (outcome !== "APPROVED") {
    requireReviewable(task);
  }

  const review = await db.taskReview.create({
    data: {
      taskId: task.id,
      attempt,
      reviewerAgentId: ctx.agentId ?? null,
      reviewerUserId: ctx.userId ?? null,
      outcome,
      notes,
      criteria: toJson(input.criteria ?? []),
    },
  });

  let nextTask: Task = task;

  // The verdict moves below run as the system, not as the reviewer: the
  // reviewer was already authorized above (task.review + self-review ban),
  // and task ownership rules must not let a reviewer rewrite foreign work
  // beyond the verdict itself.
  const verdictCtx: TaskActorContext = {
    actor: actorSystem("review-verdict"),
    correlationId,
    ...(ctx.companyId !== undefined ? { companyId: ctx.companyId } : {}),
    ...(ctx.worldId !== undefined ? { worldId: ctx.worldId } : {}),
  };

  if (outcome === "APPROVED") {
    if (task.status === "REVIEWING") {
      nextTask = await updateTask(db, task.id, { status: "COMPLETED" }, verdictCtx);
    }
  } else if (outcome === "NEEDS_CHANGES") {
    const reworks = task.reworkCount + 1;
    if (reworks > task.maxRetries) {
      nextTask = await updateTask(
        db,
        task.id,
        { status: "FAILED", error: "Rework limit exceeded", metadata: { reworkCount: reworks } },
        verdictCtx,
      );
      nextTask = await db.task.update({ where: { id: task.id }, data: { reworkCount: reworks } });
      await autoEscalate(db, task, "REPEATED_FAILURE", notes, ctx, correlationId);
    } else {
      nextTask = await updateTask(
        db,
        task.id,
        { status: "ASSIGNED", metadata: { reworkCount: reworks, reworkReason: notes.slice(0, 500) } },
        verdictCtx,
      );
      // updateTask stores metadata JSON only; the budget column is bumped
      // here so the next review reads a real counter, not a permanent zero.
      nextTask = await db.task.update({ where: { id: task.id }, data: { reworkCount: reworks } });
    }
  } else if (outcome === "REJECTED") {
    nextTask = await updateTask(
      db,
      task.id,
      { status: "FAILED", error: `Rejected in review: ${notes.slice(0, 500)}` },
      verdictCtx,
    );
  } else {
    // ESCALATE
    nextTask = await updateTask(db, task.id, { status: "BLOCKED" }, verdictCtx);
    await autoEscalate(db, task, "TASK_IMPOSSIBLE", notes, ctx, correlationId);
  }

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.TASK_REVIEWED,
    actor: ctx.actor,
    correlationId,
    targetType: "Task",
    targetId: task.id,
    companyId: task.companyId ?? undefined,
    worldId: ctx.worldId,
    payload: {
      taskId: task.id,
      attempt,
      reviewerAgentId: review.reviewerAgentId,
      outcome,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "task.review",
    targetType: "Task",
    targetId: task.id,
    correlationId,
    metadata: { outcome, attempt, reviewId: review.id, nextStatus: nextTask.status },
  });

  return { review, task: nextTask };
}

function requireReviewable(task: Task): void {
  if (task.status !== "REVIEWING") {
    throw conflict(
      "Non-approving review outcomes require a task in REVIEWING",
      { taskId: task.id, status: task.status },
    );
  }
}

async function autoEscalate(
  db: DbClient,
  task: Task,
  category: "REPEATED_FAILURE" | "TASK_IMPOSSIBLE",
  detail: string,
  ctx: ReviewActorContext,
  correlationId: string,
): Promise<void> {
  const fromAgentId = task.assigneeAgentId ?? ctx.agentId;
  if (fromAgentId === undefined || fromAgentId === null) return;

  // The system raises this, not the reviewer: review-driven escalations must
  // never fail because the reviewer's permission set happened to lack escalate.
  const escalationCtx: EscalationActorContext = {
    actor: { actorType: "SYSTEM" } as ActorRef,
    agentId: ctx.agentId,
    userId: ctx.userId,
    correlationId,
    companyId: ctx.companyId,
    worldId: ctx.worldId,
  };

  await raiseEscalation(
    db,
    {
      fromAgentId,
      category,
      detail: `Review-driven escalation on task "${task.title}": ${detail}`,
      taskId: task.id,
    },
    escalationCtx,
  );
}

export async function listReviews(db: DbClient, taskId: string): Promise<TaskReview[]> {
  return db.taskReview.findMany({
    where: { taskId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getReview(db: DbClient, reviewId: string): Promise<TaskReview> {
  const review = await db.taskReview.findUnique({ where: { id: reviewId } });
  if (review === null) throw notFound("Review", reviewId);
  return review;
}


