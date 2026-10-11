/**
 * Lightweight waypoint navigation derived from the REAL layout plan.
 *
 * Nodes come from road-segment endpoints plus every place where two road
 * segments cross (so perpendicular streets connect at intersections), and
 * every building contributes a "door" node on its street-facing side linked
 * to the nearest road nodes. Routing is A* with a Euclidean heuristic.
 *
 * Pure data in, pure data out: no three.js, no DOM, fully deterministic.
 * Anything unreachable is reported as a failure reason — never papered over
 * with a straight line through buildings.
 */

export interface NavPoint {
  x: number;
  z: number;
}

export interface RoadInput {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export interface NavGraph {
  nodes: NavPoint[];
  /** Undirected adjacency; each list is sorted ascending for determinism. */
  neighbors: number[][];
}

export type RouteFailureReason =
  | "empty-graph"
  | "invalid-point"
  | "no-snap-from"
  | "no-snap-to"
  | "disconnected";

export type RouteResult =
  | { ok: true; waypoints: NavPoint[]; distance: number }
  | { ok: false; reason: RouteFailureReason };

export const DEFAULT_MAX_SNAP_FROM = 14;
export const DEFAULT_MAX_SNAP_TO = 18;
/** Standing exactly here counts as arrived; also the equality threshold. */
export const ARRIVAL_RADIUS = 0.5;
/** Half the world ground size (see layout GROUND_SIZE = 480). */
export const WORLD_HALF_SIZE = 240;

function isFinitePoint(p: NavPoint): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.z);
}

function dist(a: NavPoint, b: NavPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Two-segment intersection; returns params t (on ab) and u (on cd), or null. */
function segmentIntersection(
  a: NavPoint,
  b: NavPoint,
  c: NavPoint,
  d: NavPoint,
): { t: number; u: number } | null {
  const rX = b.x - a.x;
  const rZ = b.z - a.z;
  const sX = d.x - c.x;
  const sZ = d.z - c.z;
  const denom = rX * sZ - rZ * sX;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const t = ((c.x - a.x) * sZ - (c.z - a.z) * sX) / denom;
  const u = ((c.x - a.x) * rZ - (c.z - a.z) * rX) / denom;
  return { t, u };
}

interface Segment {
  a: NavPoint;
  b: NavPoint;
}

/**
 * Builds a routable graph from road segments plus building door points.
 * Invalid segments (non-finite, zero-length) are skipped.
 */
export function buildNavGraph(
  roads: readonly RoadInput[],
  doors: readonly NavPoint[] = [],
  opts: { maxDoorLink?: number; maxBridge?: number } = {},
): NavGraph {
  // Doors sit on street frontage, but orphan lots can land far from any
  // road: doors chain through each other so a whole block still connects.
  const maxDoorLink = opts.maxDoorLink ?? 120;
  // Short pedestrian cuts between nearby-but-disjoint networks (e.g. an
  // arterial ending just short of a district street). Documented, bounded,
  // and never a claim of full obstacle avoidance.
  const maxBridge = opts.maxBridge ?? 45;
  const segments: Segment[] = [];
  for (const road of roads) {
    const a = { x: road.x1, z: road.z1 };
    const b = { x: road.x2, z: road.z2 };
    if (!isFinitePoint(a) || !isFinitePoint(b)) continue;
    if (dist(a, b) < 1e-6) continue;
    segments.push({ a, b });
  }

  // Interior crossing points split both segments (street intersections).
  const cuts = new Map<number, number[]>();
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const s = segments[i];
      const t = segments[j];
      if (s === undefined || t === undefined) continue;
      const hit = segmentIntersection(s.a, s.b, t.a, t.b);
      if (hit === null) continue;
      if (hit.t > 1e-6 && hit.t < 1 - 1e-6) {
        const list = cuts.get(i) ?? [];
        list.push(hit.t);
        cuts.set(i, list);
      }
      if (hit.u > 1e-6 && hit.u < 1 - 1e-6) {
        const list = cuts.get(j) ?? [];
        list.push(hit.u);
        cuts.set(j, list);
      }
    }
  }

  const nodes: NavPoint[] = [];
  const neighbors: number[][] = [];
  const indexByKey = new Map<string, number>();

  const nodeIndex = (p: NavPoint): number => {
    const key = `${Math.round(p.x * 100)},${Math.round(p.z * 100)}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = nodes.length;
    nodes.push({ x: p.x, z: p.z });
    neighbors.push([]);
    indexByKey.set(key, index);
    return index;
  };

  const link = (i: number, j: number): void => {
    if (i === j) return;
    const a = neighbors[i];
    const b = neighbors[j];
    if (a === undefined || b === undefined) return;
    if (!a.includes(j)) a.push(j);
    if (!b.includes(i)) b.push(i);
  };

  segments.forEach((segment, index) => {
    const params = [0, 1, ...(cuts.get(index) ?? [])].sort((p, q) => p - q);
    let prevNode = -1;
    let prevT = -1;
    for (const t of params) {
      if (prevNode >= 0 && t - prevT < 1e-9) continue; // duplicate cut
      const p = {
        x: segment.a.x + (segment.b.x - segment.a.x) * t,
        z: segment.a.z + (segment.b.z - segment.a.z) * t,
      };
      const current = nodeIndex(p);
      if (prevNode >= 0) link(prevNode, current);
      prevNode = current;
      prevT = t;
    }
  });

  // Door nodes join the graph through their nearest neighbors — roads or
  // earlier doors — so a block of adjacent lots chains together.
  for (const door of doors) {
    if (!isFinitePoint(door)) continue;
    const before = nodes.length;
    const doorIndex = nodeIndex(door);
    if (doorIndex < before) continue; // already on the graph
    let bestA = -1;
    let bestB = -1;
    let bestADist = maxDoorLink;
    let bestBDist = maxDoorLink;
    for (let i = 0; i < doorIndex; i += 1) {
      const node = nodes[i];
      if (node === undefined) continue;
      const d = dist(door, node);
      if (d < bestADist) {
        bestB = bestA;
        bestBDist = bestADist;
        bestA = i;
        bestADist = d;
      } else if (d < bestBDist) {
        bestB = i;
        bestBDist = d;
      }
    }
    if (bestA >= 0) link(doorIndex, bestA);
    if (bestB >= 0) link(doorIndex, bestB);
  }

  bridgeComponents(nodes, neighbors, maxBridge);

  for (const list of neighbors) list.sort((a, b) => a - b);
  return { nodes, neighbors };
}

/**
 * Joins near-touching components with short pedestrian cuts until every
 * remaining gap exceeds `maxBridge`. Deterministic: index-ordered scan,
 * first strictly-shortest pair wins.
 */
function bridgeComponents(nodes: NavPoint[], neighbors: number[][], maxBridge: number): void {
  for (;;) {
    const componentOf = componentsOf(nodes, neighbors);
    let bestA = -1;
    let bestB = -1;
    let bestDist = maxBridge;
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < nodes.length; j += 1) {
        if (componentOf[i] === componentOf[j]) continue;
        const b = nodes[j];
        if (b === undefined) continue;
        const d = dist(a, b);
        if (d < bestDist) {
          bestDist = d;
          bestA = i;
          bestB = j;
        }
      }
    }
    if (bestA < 0 || bestB < 0) return;
    const a = neighbors[bestA];
    const b = neighbors[bestB];
    if (a === undefined || b === undefined) return;
    if (!a.includes(bestB)) a.push(bestB);
    if (!b.includes(bestA)) b.push(bestA);
  }
}

function componentsOf(nodes: NavPoint[], neighbors: number[][]): number[] {
  const componentOf = new Array<number>(nodes.length).fill(-1);
  let count = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    if (componentOf[i] !== -1) continue;
    const stack = [i];
    componentOf[i] = count;
    while (stack.length > 0) {
      const n = stack.pop();
      if (n === undefined) continue;
      for (const m of neighbors[n] ?? []) {
        if (componentOf[m] === -1) {
          componentOf[m] = count;
          stack.push(m);
        }
      }
    }
    count += 1;
  }
  return componentOf;
}

/** Street-facing interaction point: front (+Z rotated) + margin outside. */
export function doorForBuilding(
  x: number,
  z: number,
  rotation: number,
  depth: number,
  margin = 1.5,
): NavPoint {
  const dirX = Math.sin(rotation);
  const dirZ = Math.cos(rotation);
  return { x: x + dirX * (depth / 2 + margin), z: z + dirZ * (depth / 2 + margin) };
}

/**
 * Operator interaction-pin override from location metadata. The layout
 * engine documents `metadata.x/z` as operator pins; when present and finite
 * they replace the computed door as the walk-to point. Accepts parsed JSON
 * or the raw TEXT column (older snapshots) — anything else yields null.
 */
export function readInteractionPin(metadata: unknown): NavPoint | null {
  let obj: unknown = metadata;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const x = record.x;
  const z = record.z;
  if (typeof x !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

/** Clamps a point into the valid world square; NaN stays NaN (fails later). */
export function clampToWorld(p: NavPoint, halfSize = WORLD_HALF_SIZE): NavPoint {
  return {
    x: Math.max(-halfSize, Math.min(halfSize, p.x)),
    z: Math.max(-halfSize, Math.min(halfSize, p.z)),
  };
}

function nearestNode(nodes: readonly NavPoint[], p: NavPoint): { index: number; distance: number } {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const d = dist(p, node);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return { index: best, distance: bestDist };
}

/**
 * A* over the nav graph. Waypoints always end exactly at `to` (the caller
 * appends nothing); an empty waypoint list with ok:true means already there.
 */
export function findRoute(
  graph: NavGraph,
  from: NavPoint,
  to: NavPoint,
  opts: { maxSnapFrom?: number; maxSnapTo?: number; allowFarStart?: boolean } = {},
): RouteResult {
  const maxSnapFrom = opts.maxSnapFrom ?? DEFAULT_MAX_SNAP_FROM;
  const maxSnapTo = opts.maxSnapTo ?? DEFAULT_MAX_SNAP_TO;
  // A far start walks straight to the nearest road first ("walk to the
  // road"); destinations stay strictly validated — never invented.
  const allowFarStart = opts.allowFarStart ?? false;
  if (graph.nodes.length === 0) return { ok: false, reason: "empty-graph" };
  if (!isFinitePoint(from) || !isFinitePoint(to)) return { ok: false, reason: "invalid-point" };
  if (dist(from, to) <= ARRIVAL_RADIUS) return { ok: true, waypoints: [], distance: 0 };

  const start = nearestNode(graph.nodes, from);
  if (start.index < 0 || (!allowFarStart && start.distance > maxSnapFrom)) {
    return { ok: false, reason: "no-snap-from" };
  }
  const goal = nearestNode(graph.nodes, to);
  if (goal.index < 0 || goal.distance > maxSnapTo) return { ok: false, reason: "no-snap-to" };

  if (start.index === goal.index) {
    return { ok: true, waypoints: [{ x: to.x, z: to.z }], distance: dist(from, to) };
  }

  // A* with a Euclidean heuristic; open list is a plain array (graphs are tiny).
  const gScore = new Map<number, number>([[start.index, 0]]);
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  const open: number[] = [start.index];
  const heuristic = (i: number): number => {
    const node = graph.nodes[i];
    return node === undefined ? Infinity : dist(node, to);
  };

  let found = false;
  while (open.length > 0) {
    let bestPos = 0;
    let bestF = Infinity;
    for (let k = 0; k < open.length; k += 1) {
      const node = open[k];
      if (node === undefined) continue;
      const f = (gScore.get(node) ?? Infinity) + heuristic(node);
      if (f < bestF || (f === bestF && node < (open[bestPos] ?? Infinity))) {
        bestF = f;
        bestPos = k;
      }
    }
    const current = open.splice(bestPos, 1)[0];
    if (current === undefined) break;
    if (current === goal.index) {
      found = true;
      break;
    }
    if (closed.has(current)) continue;
    closed.add(current);
    const neighbors = graph.neighbors[current] ?? [];
    for (const next of neighbors) {
      if (closed.has(next)) continue;
      const a = graph.nodes[current];
      const b = graph.nodes[next];
      if (a === undefined || b === undefined) continue;
      const tentative = (gScore.get(current) ?? Infinity) + dist(a, b);
      if (tentative < (gScore.get(next) ?? Infinity)) {
        gScore.set(next, tentative);
        cameFrom.set(next, current);
        if (!open.includes(next)) open.push(next);
      }
    }
  }

  if (!found) return { ok: false, reason: "disconnected" };

  const chain: number[] = [];
  let cursor: number | undefined = goal.index;
  while (cursor !== undefined && cursor !== start.index) {
    chain.push(cursor);
    cursor = cameFrom.get(cursor);
  }
  chain.reverse();
  const waypoints = chain.map((i) => {
    const node = graph.nodes[i];
    return { x: node?.x ?? 0, z: node?.z ?? 0 };
  });
  waypoints.push({ x: to.x, z: to.z });

  let distance = dist(from, waypoints[0] ?? to);
  for (let i = 1; i < waypoints.length; i += 1) {
    const p = waypoints[i - 1];
    const q = waypoints[i];
    if (p !== undefined && q !== undefined) distance += dist(p, q);
  }
  return { ok: true, waypoints, distance };
}

/** Cheap cache key so the view rebuilds the graph only when roads change. */
export function graphSignature(roads: readonly RoadInput[], doorCount: number): string {
  let checksum = 0;
  for (const road of roads) {
    checksum += Math.round(road.x1) + Math.round(road.z1) * 3 + Math.round(road.x2) * 5 + Math.round(road.z2) * 7;
  }
  return `${roads.length}:${doorCount}:${checksum}`;
}
