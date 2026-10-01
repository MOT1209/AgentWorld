/**
 * Action system.
 *
 * Every simulation-level action passes through ONE validation function before
 * anything is written. This is the answer to "never trust raw AI output": an
 * action proposed by a model, by the decision engine, or by an operator is only
 * ever a *proposal* until `validateAction` has checked, in order:
 *
 *   1. schema       - the action parses and is a known type
 *   2. agent        - exists, is active, is not OFFLINE/ERROR
 *   3. world        - exists and is RUNNING
 *   4. permission   - the caller may act on this agent
 *   5. target       - the location exists / belongs to this world
 *   6. transition   - the resulting agent state is a legal lifecycle move
 *   7. conflicts    - no second open activity, etc.
 *
 * Only then does `executeAction` mutate anything, and each mutation goes
 * through the domain services (so events and history are emitted as usual).
 */
import { z } from "zod";
import {
  ActivityTypeSchema,
  AgentStateSchema,
  canTransitionAgentState,
  newCorrelationId,
  notFound,
  validationError,
  type ActorRef,
  type ActivityType,
  type AgentState,
} from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Agent, AgentState as AgentStateRow, AgentActivity, World } from "../../database/src/types.js";
import { getActiveWorld, getLocation, moveAgent, requireWorld } from "../../world/src/index.js";
import { changeAgentState, getAgentState } from "../../agents/src/index.js";
import { PERMISSIONS } from "../../security/src/permissions.js";
import { closeActivity, completeActivity, getOpenActivity, startActivity } from "./activities.js";
import { DEFAULT_DURATIONS } from "./decision.js";

export const MoveActionSchema = z.object({
  type: z.literal("MOVE"),
  toLocationId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export const StartActivityActionSchema = z.object({
  type: z.literal("START_ACTIVITY"),
  activityType: ActivityTypeSchema,
  durationSimMinutes: z.number().int().min(1).max(1440).optional(),
  reason: z.string().max(500).optional(),
});

export const StopActivityActionSchema = z.object({
  type: z.literal("STOP_ACTIVITY"),
  reason: z.string().max(500).optional(),
});

export const RestActionSchema = z.object({
  type: z.literal("REST"),
  durationSimMinutes: z.number().int().min(1).max(1440).optional(),
  reason: z.string().max(500).optional(),
});

export const IdleActionSchema = z.object({
  type: z.literal("IDLE"),
  reason: z.string().max(500).optional(),
});

export const AgentActionSchema = z.discriminatedUnion("type", [
  MoveActionSchema,
  StartActivityActionSchema,
  StopActivityActionSchema,
  RestActionSchema,
  IdleActionSchema,
]);

export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentActionType = AgentAction["type"];

/** Resulting agent state per activity type. */
export const ACTIVITY_STATE: Record<ActivityType, AgentState> = {
  WORK: "WORKING",
  THINK: "THINKING",
  TRAVEL: "TRAVELING",
  REST: "RESTING",
  SOCIALIZE: "SOCIALIZING",
  SLEEP: "SLEEPING",
  IDLE: "IDLE",
};

export interface ActionContext {
  actor: ActorRef;
  correlationId?: string;
  worldId?: string;
  permissions?: ReadonlySet<string>;
  /** Simulated "now". Defaults to the wall clock; the engine passes the clock. */
  now?: Date;
}

export interface ActionValidation {
  action: AgentAction;
  agent: Agent;
  agentState: AgentStateRow;
  world: World;
  openActivity: AgentActivity | null;
  /** The state the agent will end in, or null when the action keeps it. */
  targetState: AgentState | null;
  now: Date;
}

export interface ActionExecutionResult {
  agentId: string;
  action: AgentActionType;
  state: AgentState;
  locationId: string | null;
  activityId: string | null;
  message: string;
}

function parseAction(raw: unknown): AgentAction {
  const parsed = AgentActionSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError("Invalid agent action", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    });
  }
  return parsed.data;
}

/**
 * The single validation gate. Throws an AppError (400/404/409) describing the
 * first failed check; returns everything `executeAction` needs otherwise.
 */
export async function validateAction(
  db: DbClient,
  agentId: string,
  raw: unknown,
  ctx: ActionContext,
): Promise<ActionValidation> {
  const action = parseAction(raw);
  const now = ctx.now ?? new Date();

  // 2. Agent
  const agent = await db.agent.findUnique({ where: { id: agentId } });
  if (agent === null) throw notFound("Agent", agentId);
  if (!agent.isActive) {
    throw validationError("Agent is not active", { agentId, isActive: agent.isActive });
  }

  const agentState = await getAgentState(db, agentId);
  const currentState = AgentStateSchema.parse(agentState.state);
  if (currentState === "OFFLINE") {
    throw validationError("Agent is offline and cannot act", { agentId, state: currentState });
  }
  if (currentState === "ERROR") {
    throw validationError("Agent is in ERROR; recover it before it can act", {
      agentId,
      state: currentState,
    });
  }

  // 3. World
  const world =
    agent.worldId !== null
      ? await requireWorld(db, agent.worldId)
      : await getActiveWorld(db);
  if (world.status !== "RUNNING") {
    throw validationError("World is not running; actions are not accepted", {
      worldId: world.id,
      status: world.status,
    });
  }

  // 4. Permission
  assertMayActOn(ctx, agentId);

  // 5-7. Action-specific checks
  const openActivity = await getOpenActivity(db, agentId);
  let targetState: AgentState | null = null;

  if (action.type === "MOVE") {
    if (openActivity !== null) {
      throw validationError("Cannot move while an activity is open; stop it first", {
        agentId,
        activityId: openActivity.id,
        type: openActivity.type,
      });
    }
    const location = await getLocation(db, action.toLocationId);
    const worldId = await locationWorldId(db, location.id);
    if (worldId !== null && agent.worldId !== null && worldId !== agent.worldId) {
      throw validationError("Destination location belongs to a different world", {
        toLocationId: location.id,
        worldId,
        agentWorldId: agent.worldId,
      });
    }
    targetState = "IDLE";
  }

  if (action.type === "START_ACTIVITY" || action.type === "REST") {
    const activityType: ActivityType =
      action.type === "REST" ? "REST" : action.activityType;
    if (openActivity !== null) {
      throw validationError("Agent already has an open activity", {
        agentId,
        activityId: openActivity.id,
        type: openActivity.type,
      });
    }
    const desired = ACTIVITY_STATE[activityType];
    if (!canTransitionAgentState(currentState, desired)) {
      throw validationError(`Cannot start ${activityType} from state ${currentState}`, {
        agentId,
        fromState: currentState,
        toState: desired,
      });
    }
    targetState = desired;
  }

  if (action.type === "STOP_ACTIVITY") {
    if (openActivity === null) {
      throw validationError("Agent has no open activity to stop", { agentId });
    }
    if (!canTransitionAgentState(currentState, "IDLE")) {
      throw validationError(`Cannot stop activity from state ${currentState}`, {
        agentId,
        fromState: currentState,
      });
    }
    targetState = "IDLE";
  }

  if (action.type === "IDLE") {
    if (!canTransitionAgentState(currentState, "IDLE")) {
      throw validationError(`Cannot idle from state ${currentState}`, {
        agentId,
        fromState: currentState,
      });
    }
    targetState = "IDLE";
  }

  return { action, agent, agentState, world, openActivity, targetState, now };
}

/**
 * Executes a previously validated action. Kept separate from validation so the
 * approve/deny path can be built on top of the same gate later.
 */
export async function executeAction(
  db: DbClient,
  agentId: string,
  raw: unknown,
  ctx: ActionContext,
): Promise<ActionExecutionResult> {
  const validation = await validateAction(db, agentId, raw, ctx);
  const { action, targetState, openActivity, now } = validation;
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const actionCtx = { actor: ctx.actor, correlationId, worldId: ctx.worldId };

  let locationId = validation.agent.currentLocationId;
  let activityId: string | null = null;
  let message = "";

  switch (action.type) {
    case "MOVE": {
      const moved = await moveAgent(
        db,
        { agentId, toLocationId: action.toLocationId, reason: action.reason },
        actionCtx,
      );
      locationId = moved.currentLocationId;
      if (targetState !== null && targetState !== validation.agentState.state) {
        await changeAgentState(
          db,
          { agentId, state: targetState, reason: action.reason ?? "moved" },
          actionCtx,
        );
      }
      message = `Moved to location ${action.toLocationId}`;
      break;
    }

    case "START_ACTIVITY":
    case "REST": {
      const activityType: ActivityType = action.type === "REST" ? "REST" : action.activityType;
      const duration = action.durationSimMinutes ?? DEFAULT_DURATIONS[activityType];
      const expectedEndTime = new Date(now.getTime() + duration * 60_000);
      const activity = await startActivity(
        db,
        {
          agentId,
          type: activityType,
          startTime: now,
          expectedEndTime,
          locationId: validation.agent.currentLocationId,
          metadata: { source: "action", reason: action.reason ?? null },
          active: true,
        },
        actionCtx,
      );
      activityId = activity.id;
      if (targetState !== null) {
        await changeAgentState(
          db,
          { agentId, state: targetState, activity: `${activityType}:${activity.id}` },
          actionCtx,
        );
      }
      message = `Started ${activityType} for ${duration} simulated minutes`;
      break;
    }

    case "STOP_ACTIVITY": {
      if (openActivity !== null) {
        await completeActivity(db, openActivity.id, actionCtx, {
          actualEndTime: now,
          outcome: action.reason ?? "stopped by action",
        });
        activityId = openActivity.id;
      }
      if (targetState !== null && targetState !== validation.agentState.state) {
        await changeAgentState(db, { agentId, state: targetState, reason: "activity stopped" }, actionCtx);
      }
      message = "Stopped the open activity";
      break;
    }

    case "IDLE": {
      if (openActivity !== null) {
        await closeActivity(db, openActivity.id, "CANCELLED", actionCtx, "cancelled by idle action");
        activityId = openActivity.id;
      }
      if (targetState !== null && targetState !== validation.agentState.state) {
        await changeAgentState(db, { agentId, state: targetState, reason: action.reason ?? "idle" }, actionCtx);
      }
      message = "Agent is idle";
      break;
    }
  }

  const finalState = await getAgentState(db, agentId);
  return {
    agentId,
    action: action.type,
    state: AgentStateSchema.parse(finalState.state),
    locationId,
    activityId,
    message,
  };
}

function assertMayActOn(ctx: ActionContext, agentId: string): void {
  if (ctx.actor.actorType === "SYSTEM") return;
  if (ctx.actor.actorType === "AGENT") {
    // An agent may act only on itself; controlling other agents is not a
    // Phase 1 capability and would bypass delegation entirely.
    if (ctx.actor.actorId !== agentId) {
      throw validationError("An agent may only act on itself", {
        actorId: ctx.actor.actorId ?? null,
        agentId,
      });
    }
    return;
  }
  if (ctx.permissions === undefined || !ctx.permissions.has(PERMISSIONS.AGENT_MODIFY)) {
    throw validationError("Acting on an agent requires 'agent.modify'", {
      requiredPermission: PERMISSIONS.AGENT_MODIFY,
    });
  }
}

async function locationWorldId(db: DbClient, locationId: string): Promise<string | null> {
  const location = await db.location.findUnique({
    where: { id: locationId },
    include: { city: { select: { worldId: true } } },
  });
  return location?.city.worldId ?? null;
}
