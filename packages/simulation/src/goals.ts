/**
 * Agent goals.
 *
 * Phase 1's structured goal store. The legacy `Agent.goals` JSON column stays
 * as free-form text for prompt building; THIS is the queryable lifecycle that
 * the simulation and the dashboard use, so a goal can move PENDING -> ACTIVE ->
 * COMPLETED with a progress value rather than being a static string.
 */
import {
  GoalStatusSchema,
  TaskPrioritySchema,
  newCorrelationId,
  notFound,
  type ActorRef,
} from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { AgentGoal } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";

export interface GoalContext {
  actor: ActorRef;
  correlationId?: string;
  worldId?: string;
}

export interface CreateGoalInput {
  agentId: string;
  title: string;
  description?: string | null;
  priority?: string;
  status?: string;
  progress?: number;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string | null;
  priority?: string;
  status?: string;
  progress?: number;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export async function createGoal(
  db: DbClient,
  input: CreateGoalInput,
  ctx: GoalContext,
): Promise<AgentGoal> {
  const priority = TaskPrioritySchema.parse(input.priority ?? "MEDIUM");
  const status = GoalStatusSchema.parse(input.status ?? "PENDING");
  const correlationId = ctx.correlationId ?? newCorrelationId();

  const goal = await db.agentGoal.create({
    data: {
      agentId: input.agentId,
      title: input.title.trim().slice(0, 300),
      description: input.description ?? null,
      priority,
      status,
      progress: clampProgress(input.progress ?? 0),
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_GOAL_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "AgentGoal",
    targetId: goal.id,
    worldId: ctx.worldId,
    payload: { agentId: goal.agentId, goalId: goal.id, title: goal.title, priority: goal.priority },
  });

  return goal;
}

export async function getGoal(db: DbClient, goalId: string): Promise<AgentGoal> {
  const goal = await db.agentGoal.findUnique({ where: { id: goalId } });
  if (goal === null) throw notFound("AgentGoal", goalId);
  return goal;
}

export async function listGoals(
  db: DbClient,
  query: { agentId: string; status?: string },
): Promise<AgentGoal[]> {
  return db.agentGoal.findMany({
    where: {
      agentId: query.agentId,
      ...(query.status !== undefined ? { status: query.status } : {}),
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });
}

export async function updateGoal(
  db: DbClient,
  goalId: string,
  input: UpdateGoalInput,
  ctx: GoalContext,
): Promise<AgentGoal> {
  const goal = await getGoal(db, goalId);
  const correlationId = ctx.correlationId ?? newCorrelationId();

  const status = input.status === undefined ? undefined : GoalStatusSchema.parse(input.status);
  const progress =
    input.progress === undefined
      ? status === "COMPLETED"
        ? 100
        : undefined
      : clampProgress(input.progress);

  const updated = await db.agentGoal.update({
    where: { id: goalId },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim().slice(0, 300) } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: TaskPrioritySchema.parse(input.priority) } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(progress !== undefined ? { progress } : {}),
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_GOAL_UPDATED,
    actor: ctx.actor,
    correlationId,
    targetType: "AgentGoal",
    targetId: goalId,
    worldId: ctx.worldId,
    payload: { agentId: updated.agentId, goalId, status: updated.status, progress: updated.progress },
  });

  if (updated.status === "COMPLETED" && goal.status !== "COMPLETED") {
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.AGENT_GOAL_COMPLETED,
      actor: ctx.actor,
      correlationId,
      targetType: "AgentGoal",
      targetId: goalId,
      worldId: ctx.worldId,
      payload: { agentId: updated.agentId, goalId, title: updated.title },
    });
    await recordActivity(db, {
      actor: ctx.actor,
      action: "goal.completed",
      targetType: "AgentGoal",
      targetId: goalId,
      correlationId,
      metadata: { agentId: updated.agentId, title: updated.title },
    });
  }

  return updated;
}

/**
 * Advances the agent's most-progressed ACTIVE goal by `delta` percent and
 * completes it at 100. Used by the simulation when a WORK activity finishes.
 * Returns null when the agent has no active goal -- which is normal.
 */
export async function advanceActiveGoal(
  db: DbClient,
  agentId: string,
  delta: number,
  ctx: GoalContext,
): Promise<AgentGoal | null> {
  const goal = await db.agentGoal.findFirst({
    where: { agentId, status: "ACTIVE" },
    orderBy: [{ progress: "desc" }, { createdAt: "asc" }],
  });
  if (goal === null) return null;

  const progress = clampProgress(goal.progress + delta);
  const nextStatus = progress >= 100 ? "COMPLETED" : "ACTIVE";
  return updateGoal(db, goal.id, { progress, status: nextStatus }, ctx);
}
