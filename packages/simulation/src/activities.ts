/**
 * Agent activities.
 *
 * An activity is what an agent is occupationally doing over an interval of
 * SIMULATED time (WORK, REST, SLEEP, ...). It is deliberately separate from the
 * agent's state: the state is a coarse lifecycle value, the activity carries
 * the schedule (expected end, location) that the simulation engine advances.
 *
 * Invariant: an agent has at most ONE open (PLANNED or ACTIVE) activity. That
 * is what makes "the agent's current activity" well-defined for the UI and the
 * decision engine, without a second source of truth.
 */
import { ActivityStatusSchema, ActivityTypeSchema, conflict, newCorrelationId, notFound, type ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { AgentActivity } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { OPEN_ACTIVITY_STATUSES } from "../../shared/src/index.js";

export interface ActivityContext {
  actor: ActorRef;
  correlationId?: string;
  worldId?: string;
}

export interface StartActivityInput {
  agentId: string;
  type: string;
  /** Simulated timestamp the activity begins. Defaults to now. */
  startTime?: Date;
  /** Simulated timestamp the activity is expected to finish. */
  expectedEndTime?: Date | null;
  locationId?: string | null;
  metadata?: Record<string, unknown>;
  /** When true the activity is created ACTIVE and an event is emitted. */
  active?: boolean;
}

export interface CompleteActivityInput {
  outcome?: string;
  actualEndTime?: Date;
  metadata?: Record<string, unknown>;
}

/** Creates an activity, refusing a second open one for the same agent. */
export async function startActivity(
  db: DbClient,
  input: StartActivityInput,
  ctx: ActivityContext,
): Promise<AgentActivity> {
  const type = ActivityTypeSchema.parse(input.type);
  const correlationId = ctx.correlationId ?? newCorrelationId();

  const open = await getOpenActivity(db, input.agentId);
  if (open !== null) {
    throw conflict("Agent already has an open activity", {
      agentId: input.agentId,
      activityId: open.id,
      type: open.type,
      status: open.status,
    });
  }

  const startTime = input.startTime ?? new Date();
  const isActive = input.active ?? true;
  const status = isActive || input.expectedEndTime === undefined ? "ACTIVE" : "PLANNED";

  const activity = await db.agentActivity.create({
    data: {
      agentId: input.agentId,
      type,
      status,
      startTime,
      expectedEndTime: input.expectedEndTime ?? null,
      locationId: input.locationId ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
    },
  });

  if (status === "ACTIVE") {
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.AGENT_ACTIVITY_STARTED,
      actor: ctx.actor,
      correlationId,
      targetType: "AgentActivity",
      targetId: activity.id,
      worldId: ctx.worldId,
      payload: {
        agentId: input.agentId,
        activityId: activity.id,
        type,
        locationId: activity.locationId,
      },
    });
  }

  return activity;
}

/** PLANNED -> ACTIVE. Emits nothing when already active (idempotent). */
export async function activateActivity(
  db: DbClient,
  activityId: string,
  ctx: ActivityContext,
): Promise<AgentActivity> {
  const activity = await db.agentActivity.findUnique({ where: { id: activityId } });
  if (activity === null) throw notFound("AgentActivity", activityId);
  if (activity.status === "ACTIVE") return activity;
  if (activity.status !== "PLANNED") {
    throw conflict("Only a PLANNED activity can be activated", { activityId, status: activity.status });
  }

  const updated = await db.agentActivity.update({
    where: { id: activityId },
    data: { status: "ACTIVE" },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_ACTIVITY_STARTED,
    actor: ctx.actor,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "AgentActivity",
    targetId: activityId,
    worldId: ctx.worldId,
    payload: {
      agentId: updated.agentId,
      activityId,
      type: updated.type,
      locationId: updated.locationId,
    },
  });

  return updated;
}

export async function completeActivity(
  db: DbClient,
  activityId: string,
  ctx: ActivityContext,
  input: CompleteActivityInput = {},
): Promise<{ activity: AgentActivity; durationSimMinutes: number }> {
  const activity = await getActivity(db, activityId);
  if (activity.status !== "ACTIVE" && activity.status !== "PLANNED") {
    throw conflict("Activity is not open", { activityId, status: activity.status });
  }

  const endedAt = input.actualEndTime ?? new Date();
  const rewound = endedAt.getTime() < activity.startTime.getTime();
  const durationSimMinutes = Math.max(0, (endedAt.getTime() - activity.startTime.getTime()) / 60_000);

  const updated = await db.agentActivity.update({
    where: { id: activityId },
    data: {
      status: "COMPLETED",
      actualEndTime: endedAt,
      metadata: JSON.stringify({
        ...safeJson(activity.metadata),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.metadata ?? {}),
      }),
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_ACTIVITY_COMPLETED,
    actor: ctx.actor,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "AgentActivity",
    targetId: activityId,
    worldId: ctx.worldId,
    payload: {
      agentId: activity.agentId,
      activityId,
      type: activity.type,
      durationSimMinutes: rewound ? 0 : Math.round(durationSimMinutes),
    },
  });

  return { activity: updated, durationSimMinutes: rewound ? 0 : durationSimMinutes };
}

export async function closeActivity(
  db: DbClient,
  activityId: string,
  status: "CANCELLED" | "FAILED",
  ctx: ActivityContext,
  outcome?: string,
): Promise<AgentActivity> {
  const parsed = ActivityStatusSchema.parse(status);
  const activity = await getActivity(db, activityId);
  if (activity.status !== "ACTIVE" && activity.status !== "PLANNED") {
    throw conflict("Activity is not open", { activityId, status: activity.status });
  }

  return db.agentActivity.update({
    where: { id: activityId },
    data: {
      status: parsed,
      actualEndTime: new Date(),
      metadata: JSON.stringify({ ...safeJson(activity.metadata), ...(outcome !== undefined ? { outcome } : {}) }),
    },
  });
}

export async function getActivity(db: DbClient, activityId: string): Promise<AgentActivity> {
  const activity = await db.agentActivity.findUnique({ where: { id: activityId } });
  if (activity === null) throw notFound("AgentActivity", activityId);
  return activity;
}

/** The single PLANNED or ACTIVE activity, or null. */
export async function getOpenActivity(db: DbClient, agentId: string): Promise<AgentActivity | null> {
  return db.agentActivity.findFirst({
    where: { agentId, status: { in: [...OPEN_ACTIVITY_STATUSES] } },
    orderBy: { startTime: "desc" },
  });
}

export async function listActivities(
  db: DbClient,
  query: { agentId: string; status?: string; limit?: number },
): Promise<AgentActivity[]> {
  return db.agentActivity.findMany({
    where: {
      agentId: query.agentId,
      ...(query.status !== undefined ? { status: query.status } : {}),
    },
    orderBy: [{ startTime: "desc" }],
    take: Math.min(query.limit ?? 25, 200),
  });
}

export async function countOpenActivities(db: DbClient, agentId: string): Promise<number> {
  return db.agentActivity.count({ where: { agentId, status: { in: [...OPEN_ACTIVITY_STATUSES] } } });
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
