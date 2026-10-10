/**
 * Deterministic character placement.
 *
 * Every placed position is a pure function of (agentId, locationId): the same
 * agent at the same location always stands on the same spot, regardless of
 * refresh order, arrivals, or departures. Positions never depend on array
 * indices, so inserting or removing one agent never shuffles the others.
 */

import { hashStringToUint32 } from "./characterAppearance.js";

export interface BuildingAnchor {
  locationId: string;
  x: number;
  z: number;
  /** Keep-out radius around the building centre (half footprint + margin). */
  clearance: number;
  /** Flat walkable surface (plazas, parks) — agents may stand on it. */
  walkable?: boolean;
}

export interface PlacedAgent {
  agentId: string;
  locationId: string | null;
  x: number;
  z: number;
  /** Facing direction in radians (towards the assigned building). */
  yaw: number;
  /** True when the agent has no assigned location (explicit fallback). */
  fallback: boolean;
}

/**
 * Explicit fallback plaza for agents without an assigned location. It sits in
 * the middle of the PUBLIC district, clear of the building ring, and is
 * labelled "unassigned" in the UI so it never implies a workplace.
 */
export const FALLBACK_CENTER = { x: 0, z: 20 } as const;
export const FALLBACK_SPREAD = 3.2;

/** Keep-out radius per location kind (world units). */
export function clearanceForKind(kind: string): number {
  switch (kind) {
    case "OFFICE":
      return 4.4;
    case "HQ":
    case "BANK":
      return 4.0;
    case "SHOP":
    case "MARKET":
    case "RESTAURANT":
      return 3.2;
    case "GOVERNMENT":
    case "CHURCH":
    case "SCHOOL":
    case "HOSPITAL":
      return 3.2;
    case "HOUSE":
    case "APARTMENT":
    case "HOME":
      return 2.4;
    default:
      return 2.6;
  }
}

/** Location kinds with flat walkable surfaces agents may stand on. */
export function isWalkableKind(kind: string): boolean {
  return (
    kind === "PUBLIC_SPACE" ||
    kind === "PARK" ||
    kind === "PLAZA" ||
    kind === "PLATZ"
  );
}

function unit(value: number): number {
  return (value % 1000) / 1000;
}

function placeAtAnchor(
  agentId: string,
  locationId: string,
  anchor: BuildingAnchor,
  walkable: boolean,
): PlacedAgent {
  const h = hashStringToUint32(`${agentId}|${locationId}`);
  const angle = ((h % 360) / 360) * Math.PI * 2;
  const fraction = unit(h >>> 8);
  const radius = walkable
    ? 0.8 + fraction * 2.0
    : anchor.clearance + 0.4 + fraction * 1.6;
  const x = anchor.x + Math.cos(angle) * radius;
  const z = anchor.z + Math.sin(angle) * radius;
  // Face the building (or the plaza centre for walkable surfaces).
  const yaw = Math.atan2(anchor.x - x, anchor.z - z);
  return { agentId, locationId, x, z, yaw, fallback: false };
}

function placeAtFallback(
  agentId: string,
  center: { x: number; z: number } = FALLBACK_CENTER,
): PlacedAgent {
  const h = hashStringToUint32(`${agentId}|unassigned`);
  const angle = ((h % 360) / 360) * Math.PI * 2;
  const radius = 0.6 + unit(h >>> 8) * FALLBACK_SPREAD;
  const x = center.x + Math.cos(angle) * radius;
  const z = center.z + Math.sin(angle) * radius;
  const yaw = Math.atan2(center.x - x, center.z - z);
  return { agentId, locationId: null, x, z, yaw, fallback: true };
}

export interface PlaceableAgent {
  id: string;
  locationId: string | null;
}

/**
 * Places every agent. Unknown location ids are treated like missing ones
 * (explicit fallback) — never an invented assignment.
 */
export function placeAgents<T extends PlaceableAgent>(
  agents: readonly T[],
  anchors: ReadonlyMap<string, BuildingAnchor>,
  walkableKinds: ReadonlyMap<string, boolean> = new Map(),
  fallbackCenter: { x: number; z: number } = FALLBACK_CENTER,
): PlacedAgent[] {
  return agents.map((agent) => {
    const anchor =
      agent.locationId !== null ? anchors.get(agent.locationId) : undefined;
    if (agent.locationId === null || anchor === undefined) {
      return placeAtFallback(agent.id, fallbackCenter);
    }
    const walkable = walkableKinds.get(agent.locationId) ?? anchor.walkable ?? false;
    return placeAtAnchor(agent.id, agent.locationId, anchor, walkable);
  });
}
