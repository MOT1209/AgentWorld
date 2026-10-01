/**
 * World control: start / pause / resume / stop and speed.
 *
 * The World row is the single authoritative record of simulation status --
 * there is no in-memory flag that could disagree with the database. That is why
 * a restart cannot leave the world running but nobody knows it.
 *
 * On every control change `lastTickAt` is reset to now. Without that, resuming
 * a world paused for an hour would make the first tick apply an hour of
 * accumulated simulated lead, and agents would "teleport" through a day.
 */
import {
  WorldStatusSchema,
  clampTimeScale,
  computeSimulatedTime,
  newCorrelationId,
  validationError,
  type ActorRef,
  type SimulatedTime,
  type WorldStatus,
} from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { World } from "../../database/src/types.js";
import { getActiveWorld, requireWorld } from "../../world/src/index.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";

export type WorldControlAction = "start" | "pause" | "resume" | "stop";

export interface WorldControlContext {
  actor: ActorRef;
  correlationId?: string;
}

const ALLOWED_FROM: Record<WorldControlAction, readonly WorldStatus[]> = {
  start: ["INITIALIZING", "STOPPED", "PAUSED", "ERROR"],
  pause: ["RUNNING"],
  resume: ["PAUSED"],
  stop: ["INITIALIZING", "RUNNING", "PAUSED", "ERROR"],
};

const TARGET_STATUS: Record<WorldControlAction, WorldStatus> = {
  start: "RUNNING",
  pause: "PAUSED",
  resume: "RUNNING",
  stop: "STOPPED",
};

async function resolveWorld(db: DbClient, worldId?: string): Promise<World> {
  return worldId === undefined ? getActiveWorld(db) : requireWorld(db, worldId);
}

export async function controlWorld(
  db: DbClient,
  action: WorldControlAction,
  ctx: WorldControlContext,
  worldId?: string,
): Promise<World> {
  const world = await resolveWorld(db, worldId);
  const from = WorldStatusSchema.parse(world.status);
  const to = TARGET_STATUS[action];

  if (from === to) return world;

  if (!ALLOWED_FROM[action].includes(from)) {
    throw validationError(`Cannot ${action} a world in status ${from}`, {
      worldId: world.id,
      action,
      status: from,
    });
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const updated = await db.world.update({
    where: { id: world.id },
    data: { status: to, lastTickAt: new Date() },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WORLD_STATUS_CHANGED,
    actor: ctx.actor,
    correlationId,
    targetType: "World",
    targetId: world.id,
    worldId: world.id,
    payload: {
      worldId: world.id,
      fromStatus: from,
      toStatus: to,
      timeScale: updated.timeScale,
    },
  });

  return updated;
}

export async function setWorldSpeed(
  db: DbClient,
  timeScale: number,
  ctx: WorldControlContext,
  worldId?: string,
): Promise<World> {
  const world = await resolveWorld(db, worldId);
  const scale = clampTimeScale(timeScale);
  if (scale === world.timeScale) return world;

  // lastTickAt reset: the new speed must not retroactively apply to the real
  // time that elapsed at the old speed.
  return db.world.update({
    where: { id: world.id },
    data: { timeScale: scale, lastTickAt: new Date() },
  });
}

export async function getSimulatedClock(db: DbClient, worldId?: string): Promise<SimulatedTime> {
  const world = await resolveWorld(db, worldId);
  return computeSimulatedTime(world);
}

export function isWorldRunning(world: World): boolean {
  return world.status === "RUNNING";
}
