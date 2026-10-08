/**
 * Daily routine engine (Phase 5).
 *
 * A routine is a scheduled, per-agent activity block: a slot of the simulated
 * day (0..1439), an activity type, an optional required location and a
 * duration. Routines are just data, and the simulation evaluates them on the
 * EXISTING tick -- there is no new timer or polling loop:
 *
 *   - a routine due at or before the simulated minute fires when the agent is
 *     free AND at the right place, opening an activity through the same
 *     validated path an operator's tool call would use;
 *   - every settled routine is marked `evaluatedOnSimDate`, so one simulated
 *     day can never fire the same routine twice;
 *   - a miss (late window, wrong location, busy agent, illegal state) is
 *     surfaced as a ROUTINE_SKIPPED event plus an audit row, never a crash.
 */
import { z } from "zod";
import {
  canTransitionAgentState,
  conflict,
  newCorrelationId,
  notFound,
  validationError,
  type ActorRef,
  type AgentState,
} from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { AgentRoutine } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { changeAgentState, getAgentState } from "../../agents/src/index.js";
import { ACTIVITY_STATE } from "./actions.js";
import { getOpenActivity, startActivity } from "./activities.js";

/** How many simulated minutes after its slot a routine may still fire. */
export const ROUTINE_GRACE_MINUTES = 60;
/** Within-grace overdue threshold that is still reported as "on-time". */
export const ROUTINE_ON_TIME_OVERDUE_MINUTES = 15;

/**
 * Routines may only schedule activities an agent can arrive at through a state
 * transition. IDLE is a lifecycle state, not a scheduled block, so it stays out.
 */
export const ROUTINE_ACTIVITY_TYPES = [
  "WORK",
  "REST",
  "THINK",
  "TRAVEL",
  "SOCIALIZE",
  "SLEEP",
] as const;
const RoutineActivityTypeSchema = z.enum(ROUTINE_ACTIVITY_TYPES);

const MAX_SLOT_MINUTES = 1439;
const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_MINUTES = 1440;

export interface RoutineContext {
  actor: ActorRef;
  correlationId?: string;
  worldId?: string;
}

export interface CreateRoutineInput {
  agentId: string;
  slotMinutes: number;
  activityType: string;
  locationId?: string | null;
  durationSimMinutes: number;
  active?: boolean;
}

export interface UpdateRoutineInput {
  slotMinutes?: number;
  activityType?: string;
  locationId?: string | null;
  durationSimMinutes?: number;
  active?: boolean;
}

export interface RoutineEvaluationInput {
  agentId: string;
  /** Simulated "now" the routine slots are evaluated against. */
  simulatedNow: Date;
}

export interface RoutineEvaluation {
  triggered: AgentRoutine[];
  skipped: AgentRoutine[];
  /** Routines settled (fired or marked) by this pass. */
  evaluated: number;
}

function assertValidRoutine(input: {
  slotMinutes?: number;
  activityType?: string;
  durationSimMinutes?: number;
}): void {
  if (input.slotMinutes !== undefined) {
    if (!Number.isInteger(input.slotMinutes) || input.slotMinutes < 0 || input.slotMinutes > MAX_SLOT_MINUTES) {
      throw validationError(
        `Routine slot must be a whole simulated minute between 0 and ${MAX_SLOT_MINUTES}`,
        { slotMinutes: input.slotMinutes },
      );
    }
  }
  if (input.durationSimMinutes !== undefined) {
    if (
      !Number.isInteger(input.durationSimMinutes) ||
      input.durationSimMinutes < MIN_DURATION_MINUTES ||
      input.durationSimMinutes > MAX_DURATION_MINUTES
    ) {
      throw validationError(
        `Routine duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} simulated minutes`,
        { durationSimMinutes: input.durationSimMinutes },
      );
    }
  }
  if (input.activityType !== undefined) {
    const parsed = RoutineActivityTypeSchema.safeParse(input.activityType);
    if (!parsed.success) {
      throw validationError("Unsupported routine activity type", { activityType: input.activityType });
    }
  }
}

/** A requested location must exist and live in the agent's world. */
async function assertLocationUsable(
  db: DbClient,
  locationId: string | null | undefined,
  worldId: string | null,
): Promise<void> {
  if (locationId === undefined || locationId === null) return;
  const location = await db.location.findUnique({
    where: { id: locationId },
    include: { city: { select: { worldId: true } } },
  });
  if (location === null) throw notFound("Location", locationId);
  if (worldId !== null && location.city.worldId !== worldId) {
    throw validationError("Location belongs to a different world than the agent", {
      locationId,
      agentWorldId: worldId,
      locationWorldId: location.city.worldId,
    });
  }
}

async function assertNoSlotConflict(
  db: DbClient,
  agentId: string,
  slotMinutes: number,
  activityType: string,
): Promise<void> {
  const existing = await db.agentRoutine.findFirst({
    where: { agentId, slotMinutes, activityType },
  });
  if (existing !== null) {
    throw conflict("A routine already exists for this agent at this slot", {
      agentId,
      slotMinutes,
      activityType,
    });
  }
}

/** Schedules a routine for an agent, emitting ROUTINE_CREATED + audit. */
export async function createAgentRoutine(
  db: DbClient,
  input: CreateRoutineInput,
  ctx: RoutineContext,
): Promise<AgentRoutine> {
  assertValidRoutine(input);
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const agent = await db.agent.findUnique({ where: { id: input.agentId } });
  if (agent === null) throw notFound("Agent", input.agentId);
  if (!agent.isActive) throw validationError("Agent is not active", { agentId: input.agentId });
  await assertLocationUsable(db, input.locationId, agent.worldId);
  await assertNoSlotConflict(db, input.agentId, input.slotMinutes, input.activityType);

  const routine = await db.agentRoutine.create({
    data: {
      agentId: input.agentId,
      slotMinutes: input.slotMinutes,
      activityType: input.activityType,
      locationId: input.locationId ?? null,
      durationSimMinutes: input.durationSimMinutes,
      active: input.active ?? true,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.ROUTINE_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "AgentRoutine",
    targetId: routine.id,
    worldId: ctx.worldId,
    payload: {
      routineId: routine.id,
      agentId: input.agentId,
      activityType: routine.activityType,
      slotMinutes: routine.slotMinutes,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "routine.create",
    targetType: "AgentRoutine",
    targetId: routine.id,
    correlationId,
    userId: ctx.actor.actorType === "USER" ? ctx.actor.actorId : undefined,
    metadata: {
      agentId: input.agentId,
      slotMinutes: routine.slotMinutes,
      activityType: routine.activityType,
      durationSimMinutes: routine.durationSimMinutes,
      locationId: routine.locationId,
    },
  });

  return routine;
}

/** Mutates an existing routine, emitting ROUTINE_UPDATED + audit. */
export async function updateAgentRoutine(
  db: DbClient,
  routineId: string,
  input: UpdateRoutineInput,
  ctx: RoutineContext,
): Promise<AgentRoutine> {
  const routine = await db.agentRoutine.findUnique({ where: { id: routineId } });
  if (routine === null) throw notFound("AgentRoutine", routineId);

  assertValidRoutine(input);
  const correlationId = ctx.correlationId ?? newCorrelationId();

  const agent = await db.agent.findUnique({ where: { id: routine.agentId } });
  const worldId = agent?.worldId ?? null;
  const nextLocationId = input.locationId === undefined ? routine.locationId : input.locationId;
  await assertLocationUsable(db, nextLocationId, worldId);

  const nextSlot = input.slotMinutes ?? routine.slotMinutes;
  const nextType = input.activityType ?? routine.activityType;
  await assertNoSlotConflict(db, routine.agentId, nextSlot, nextType);

  const updated = await db.agentRoutine.update({
    where: { id: routineId },
    data: {
      ...(input.slotMinutes !== undefined ? { slotMinutes: input.slotMinutes } : {}),
      ...(input.activityType !== undefined ? { activityType: input.activityType } : {}),
      ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
      ...(input.durationSimMinutes !== undefined ? { durationSimMinutes: input.durationSimMinutes } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.ROUTINE_UPDATED,
    actor: ctx.actor,
    correlationId,
    targetType: "AgentRoutine",
    targetId: updated.id,
    worldId: ctx.worldId,
    payload: {
      routineId: updated.id,
      agentId: updated.agentId,
      activityType: updated.activityType,
      slotMinutes: updated.slotMinutes,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "routine.update",
    targetType: "AgentRoutine",
    targetId: routine.id,
    correlationId,
    userId: ctx.actor.actorType === "USER" ? ctx.actor.actorId : undefined,
    metadata: {
      agentId: updated.agentId,
      slotMinutes: updated.slotMinutes,
      activityType: updated.activityType,
      durationSimMinutes: updated.durationSimMinutes,
      locationId: updated.locationId,
      active: updated.active,
    },
  });

  return updated;
}

/** Removes a routine, emitting ROUTINE_DELETED + audit. */
export async function deleteAgentRoutine(
  db: DbClient,
  routineId: string,
  ctx: RoutineContext,
): Promise<void> {
  const routine = await db.agentRoutine.findUnique({ where: { id: routineId } });
  if (routine === null) throw notFound("AgentRoutine", routineId);

  await db.agentRoutine.delete({ where: { id: routineId } });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.ROUTINE_DELETED,
    actor: ctx.actor,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "AgentRoutine",
    targetId: routineId,
    worldId: ctx.worldId,
    payload: {
      routineId,
      agentId: routine.agentId,
      activityType: routine.activityType,
      slotMinutes: routine.slotMinutes,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "routine.delete",
    targetType: "AgentRoutine",
    targetId: routineId,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    userId: ctx.actor.actorType === "USER" ? ctx.actor.actorId : undefined,
    metadata: {
      agentId: routine.agentId,
      slotMinutes: routine.slotMinutes,
      activityType: routine.activityType,
    },
  });
}

/** The active routines of an agent, earliest slot first. */
export async function listAgentRoutines(
  db: DbClient,
  query: { agentId: string; includeInactive?: boolean },
): Promise<AgentRoutine[]> {
  return db.agentRoutine.findMany({
    where: {
      agentId: query.agentId,
      ...(query.includeInactive === true ? {} : { active: true }),
    },
    orderBy: { slotMinutes: "asc" },
  });
}

/**
 * Evaluates an agent's due routines against `simulatedNow`.
 *
 * Idempotent per simulated day: a routine whose `evaluatedOnSimDate` already
 * matches today is left untouched. At most one routine is fired per call --
 * the moment one is triggered the agent is busy, which the next pass would
 * have to report anyway.
 */
export async function evaluateAgentRoutines(
  db: DbClient,
  input: RoutineEvaluationInput,
  ctx: RoutineContext,
): Promise<RoutineEvaluation> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const routines = await db.agentRoutine.findMany({
    where: { agentId: input.agentId, active: true },
    orderBy: { slotMinutes: "asc" },
  });

  const agent = await db.agent.findUnique({ where: { id: input.agentId } });
  if (agent === null) throw notFound("Agent", input.agentId);

  const today = simDateKey(input.simulatedNow);
  const minute = minutesOfDayOf(input.simulatedNow);
  const open = await getOpenActivity(db, input.agentId);
  const state = await getAgentState(db, input.agentId);

  const triggered: AgentRoutine[] = [];
  const skipped: AgentRoutine[] = [];

  const settle = (routineId: string): Promise<unknown> =>
    db.agentRoutine.update({ where: { id: routineId }, data: { evaluatedOnSimDate: today } });

  const reportSkip = async (routine: AgentRoutine, reason: string): Promise<void> => {
    await settle(routine.id);
    skipped.push(routine);
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.ROUTINE_SKIPPED,
      actor: ctx.actor,
      correlationId,
      targetType: "AgentRoutine",
      targetId: routine.id,
      worldId: ctx.worldId,
      payload: {
        routineId: routine.id,
        agentId: input.agentId,
        activityType: routine.activityType,
        slotMinutes: routine.slotMinutes,
        reason,
      },
    });
    await recordActivity(db, {
      actor: ctx.actor,
      action: "routine.skipped",
      targetType: "AgentRoutine",
      targetId: routine.id,
      correlationId,
      result: "OK",
      metadata: {
        agentId: input.agentId,
        slotMinutes: routine.slotMinutes,
        activityType: routine.activityType,
        reason,
      },
    });
  };

  for (const routine of routines) {
    if (routine.evaluatedOnSimDate === today) continue;
    if (routine.slotMinutes > minute) continue;

    const overdueMinutes = minute - routine.slotMinutes;
    if (overdueMinutes > ROUTINE_GRACE_MINUTES) {
      await reportSkip(routine, "late-window");
      continue;
    }
    if (open !== null) {
      await reportSkip(routine, "agent-busy");
      continue;
    }
    if (routine.locationId !== null && routine.locationId !== agent.currentLocationId) {
      await reportSkip(routine, "not-at-location");
      continue;
    }
    const desired = ACTIVITY_STATE[routine.activityType as keyof typeof ACTIVITY_STATE];
    if (!canTransitionAgentState(state.state as AgentState, desired)) {
      await reportSkip(routine, "state-mismatch");
      continue;
    }

    const reason = overdueMinutes <= ROUTINE_ON_TIME_OVERDUE_MINUTES ? "on-time" : "late-window";
    const expectedEndTime = new Date(input.simulatedNow.getTime() + routine.durationSimMinutes * 60_000);
    const activity = await startActivity(
      db,
      {
        agentId: input.agentId,
        type: routine.activityType,
        startTime: input.simulatedNow,
        expectedEndTime,
        locationId: routine.locationId ?? agent.currentLocationId,
        metadata: { source: "routine", routineId: routine.id },
        active: true,
      },
      ctx,
    );

    await changeAgentState(
      db,
      {
        agentId: input.agentId,
        state: desired,
        activity: `${routine.activityType}:${activity.id}`,
        reason: `Routine scheduled at ${routine.slotMinutes} (${reason})`,
      },
      ctx,
    );

    await db.agentRoutine.update({
      where: { id: routine.id },
      data: { lastTriggeredSimDate: today, evaluatedOnSimDate: today },
    });

    triggered.push(routine);
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.ROUTINE_TRIGGERED,
      actor: ctx.actor,
      correlationId,
      targetType: "AgentRoutine",
      targetId: routine.id,
      worldId: ctx.worldId,
      payload: {
        routineId: routine.id,
        agentId: input.agentId,
        activityId: activity.id,
        activityType: routine.activityType,
        slotMinutes: routine.slotMinutes,
        reason,
      },
    });
    await recordActivity(db, {
      actor: ctx.actor,
      action: "routine.triggered",
      targetType: "AgentRoutine",
      targetId: routine.id,
      correlationId,
      result: "OK",
      metadata: {
        agentId: input.agentId,
        activityId: activity.id,
        slotMinutes: routine.slotMinutes,
        activityType: routine.activityType,
        reason,
      },
    });

    break;
  }

  return { triggered, skipped, evaluated: triggered.length + skipped.length };
}

/** The simulated day a timestamp belongs to. */
export function simDateKey(of: Date): string {
  const month = String(of.getMonth() + 1).padStart(2, "0");
  const day = String(of.getDate()).padStart(2, "0");
  return `${of.getFullYear()}-${month}-${day}`;
}

/** Minutes since simulated midnight (0..1439). */
function minutesOfDayOf(of: Date): number {
  return of.getHours() * 60 + of.getMinutes();
}