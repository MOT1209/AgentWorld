/**
 * World, cities, locations, and the simulation clock.
 *
 * The Phase 1 world is data, not geometry. `Location` is a logical place with a
 * kind and a capacity, which is all an agent needs in order to "be at" the
 * bank. Everything Phase 2 needs to add - districts, roads, buildings, travel
 * time - is a new model or a new column, and the agent-facing concept that
 * matters (`currentLocationId`) already exists and is already indexed.
 */
import {
  LocationKindSchema,
  newCorrelationId,
  validationError,
  type ActorRef,
} from "../../shared/src/index.js";
import { conflict, notFound } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Agent, City, Location, World } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";
import { computeSimulatedTime, nextOffset, type SimulatedTime } from "../../shared/src/time.js";

export interface WorldContext {
  actor: ActorRef;
  correlationId?: string;
}

export async function createWorld(
  db: DbClient,
  input: { name: string; description?: string; timeScale?: number },
  ctx: WorldContext,
): Promise<World> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const world = await db.world.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      timeScale: input.timeScale ?? 60,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WORLD_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "World",
    targetId: world.id,
    worldId: world.id,
    payload: { worldId: world.id, name: world.name },
  });

  return world;
}

export async function getActiveWorld(db: DbClient): Promise<World> {
  const world = await db.world.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (world === null) throw notFound("Active world");
  return world;
}

export async function listWorlds(db: DbClient): Promise<World[]> {
  return db.world.findMany({ orderBy: { createdAt: "asc" } });
}

export async function createCity(
  db: DbClient,
  input: { worldId: string; name: string; description?: string; kind?: string },
  _ctx: WorldContext,
): Promise<City> {
  await requireWorld(db, input.worldId);
  return db.city.create({
    data: {
      worldId: input.worldId,
      name: input.name,
      description: input.description ?? null,
      kind: input.kind ?? "CITY",
    },
  });
}

export interface CreateLocationInput {
  cityId: string;
  name: string;
  kind: string;
  address?: string | null;
  capacity?: number | null;
  metadata?: Record<string, unknown>;
}

export async function createLocation(
  db: DbClient,
  input: CreateLocationInput,
  ctx: WorldContext,
): Promise<Location> {
  const city = await db.city.findUnique({ where: { id: input.cityId } });
  if (city === null) throw notFound("City", input.cityId);

  const kind = LocationKindSchema.parse(input.kind);
  const correlationId = ctx.correlationId ?? newCorrelationId();

  const existing = await db.location.findUnique({
    where: { cityId_name: { cityId: input.cityId, name: input.name } },
  });
  if (existing !== null) {
    throw conflict("A location with that name already exists in this city", {
      cityId: input.cityId,
      name: input.name,
    });
  }

  const location = await db.location.create({
    data: {
      cityId: input.cityId,
      name: input.name,
      kind,
      address: input.address ?? null,
      capacity: input.capacity ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "world.create_location",
    targetType: "Location",
    targetId: location.id,
    correlationId,
    metadata: { cityId: input.cityId, kind, name: input.name },
  });

  return location;
}

export async function listCities(db: DbClient, worldId: string): Promise<City[]> {
  return db.city.findMany({ where: { worldId }, orderBy: { name: "asc" } });
}

export async function listLocations(
  db: DbClient,
  query: { worldId?: string; cityId?: string; kind?: string },
): Promise<Array<Location & { cityName: string }>> {
  const rows = await db.location.findMany({
    where: {
      ...(query.cityId !== undefined ? { cityId: query.cityId } : {}),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.worldId !== undefined ? { city: { worldId: query.worldId } } : {}),
    },
    include: { city: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => ({ ...row, cityName: row.city.name }));
}

export async function getLocation(db: DbClient, locationId: string): Promise<Location> {
  const location = await db.location.findUnique({ where: { id: locationId } });
  if (location === null) throw notFound("Location", locationId);
  return location;
}

/**
 * Moves an agent between locations.
 *
 * Phase 1 performs the move instantly; Phase 2 will introduce travel time and
 * an intermediate `TRAVELLING` state. The signature already carries the
 * destination and emits LOCATION_CHANGED, so the simulation layer can hook
 * travel without changing any caller.
 */
export async function moveAgent(
  db: DbClient,
  input: { agentId: string; toLocationId: string | null; reason?: string },
  ctx: WorldContext,
): Promise<Agent> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const agent = await db.agent.findUnique({ where: { id: input.agentId } });
  if (agent === null) throw notFound("Agent", input.agentId);

  if (input.toLocationId !== null) {
    await getLocation(db, input.toLocationId);
  }

  if (agent.currentLocationId === input.toLocationId) return agent;

  const updated = await db.agent.update({
    where: { id: input.agentId },
    data: { currentLocationId: input.toLocationId },
  });

  await db.agentState.updateMany({
    where: { agentId: input.agentId },
    data: { currentLocationId: input.toLocationId, lastActivityAt: new Date() },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.LOCATION_CHANGED,
    actor: ctx.actor,
    correlationId,
    targetType: "Agent",
    targetId: input.agentId,
    worldId: agent.worldId ?? undefined,
    payload: {
      agentId: input.agentId,
      fromLocationId: agent.currentLocationId,
      toLocationId: input.toLocationId,
    },
  });

  return updated;
}

// =============================================================================
// SIMULATION CLOCK
// =============================================================================

export async function getSimulatedTime(db: DbClient, worldId?: string): Promise<SimulatedTime> {
  const world =
    worldId === undefined ? await getActiveWorld(db) : await requireWorld(db, worldId);
  return computeSimulatedTime(world);
}

/**
 * Advances the world offset by the real time elapsed since the last tick.
 *
 * Idempotent per tick because the offset is persisted rather than recomputed
 * from a fixed epoch: two heartbeats cannot double-apply the same interval,
 * which matters once the heartbeat drives agent behaviour.
 */
export async function tickWorld(
  db: DbClient,
  worldId?: string,
): Promise<{ world: World; simulated: SimulatedTime }> {
  const world = worldId === undefined ? await getActiveWorld(db) : await requireWorld(db, worldId);
  const now = new Date();
  const offset = nextOffset(world, world.timeScale, now);

  const updated = await db.world.update({
    where: { id: world.id },
    data: { timeOffsetMinutes: offset, lastTickAt: now },
  });

  const simulated = computeSimulatedTime(updated, now);

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WORLD_TICK,
    actor: { actorType: "SYSTEM", actorName: "simulation-clock" },
    correlationId: newCorrelationId(),
    worldId: updated.id,
    payload: {
      worldId: updated.id,
      simulatedNow: simulated.simulatedNow.toISOString(),
      phase: simulated.phase,
    },
  });

  return { world: updated, simulated };
}

export async function requireWorld(db: DbClient, worldId: string): Promise<World> {
  const world = await db.world.findUnique({ where: { id: worldId } });
  if (world === null) throw notFound("World", worldId);
  return world;
}

export interface WorldSnapshot {
  world: {
    id: string;
    name: string;
    description: string | null;
    timeScale: number;
    timeOffsetMinutes: number;
  };
  simulatedNow: string;
  wallNow: string;
  phase: string;
  cities: Array<{ id: string; name: string; kind: string; population: number; locationCount: number }>;
  locations: Array<{
    id: string;
    name: string;
    kind: string;
    cityId: string;
    cityName: string;
    occupantCount: number;
  }>;
  agentCount: number;
}

/** Everything the `world.get_state` tool and the dashboard need, in one call. */
export async function getWorldSnapshot(db: DbClient, worldId?: string): Promise<WorldSnapshot> {
  const world = worldId === undefined ? await getActiveWorld(db) : await requireWorld(db, worldId);
  const simulated = computeSimulatedTime(world);

  const [cities, locations, agentCount] = await Promise.all([
    db.city.findMany({
      where: { worldId: world.id },
      include: { _count: { select: { locations: true } } },
      orderBy: { name: "asc" },
    }),
    db.location.findMany({
      where: { city: { worldId: world.id } },
      include: { city: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    db.agent.count({ where: { worldId: world.id } }),
  ]);

  const occupants = new Map<string, number>();
  const agents = await db.agent.findMany({
    where: { worldId: world.id, currentLocationId: { not: null } },
    select: { currentLocationId: true },
  });
  for (const agent of agents) {
    if (agent.currentLocationId === null) continue;
    occupants.set(agent.currentLocationId, (occupants.get(agent.currentLocationId) ?? 0) + 1);
  }

  return {
    world: {
      id: world.id,
      name: world.name,
      description: world.description,
      timeScale: world.timeScale,
      timeOffsetMinutes: world.timeOffsetMinutes,
    },
    simulatedNow: simulated.simulatedNow.toISOString(),
    wallNow: simulated.wallNow.toISOString(),
    phase: simulated.phase,
    cities: cities.map((city) => ({
      id: city.id,
      name: city.name,
      kind: city.kind,
      population: city.population,
      locationCount: city._count.locations,
    })),
    locations: locations.map((location) => ({
      id: location.id,
      name: location.name,
      kind: location.kind,
      cityId: location.cityId,
      cityName: location.city.name,
      occupantCount: occupants.get(location.id) ?? 0,
    })),
    agentCount,
  };
}

export async function getLocationDetail(
  db: DbClient,
  locationId: string,
): Promise<{ location: Location; city: City; occupants: Array<{ id: string; name: string; title: string }> }> {
  const location = await db.location.findUnique({
    where: { id: locationId },
    include: { city: true },
  });
  if (location === null) throw notFound("Location", locationId);

  const agents = await db.agent.findMany({
    where: { currentLocationId: locationId },
    select: { id: true, name: true, title: true },
  });

  return { location, city: location.city, occupants: agents };
}

export function assertLocationCapacity(location: Location, occupants: number): void {
  if (location.capacity === null) return;
  if (occupants >= location.capacity) {
    throw validationError("Location is at capacity", {
      locationId: location.id,
      capacity: location.capacity,
    });
  }
}
