/**
 * Step 3 navigation: waypoint graph from real roads, door nodes, A* routing.
 * Pure data — no DOM, no renderer.
 */
import { describe, it, expect } from "vitest";
import {
  buildNavGraph,
  findRoute,
  doorForBuilding,
  clampToWorld,
  graphSignature,
  ARRIVAL_RADIUS,
} from "../apps/web/src/world/navigation.js";

const L_ROADS = [
  { x1: 0, z1: 0, x2: 10, z2: 0, width: 4, surface: "ASPHALT", sidewalk: true, id: "a" },
  { x1: 10, z1: 0, x2: 10, z2: 10, width: 4, surface: "ASPHALT", sidewalk: true, id: "b" },
] as const;

describe("nav graph construction", () => {
  it("links segments that share an endpoint", () => {
    const graph = buildNavGraph([...L_ROADS], []);
    expect(graph.nodes.length).toBe(3);
    // Middle node (10,0) has two neighbors; ends have one each.
    const degrees = graph.neighbors.map((n) => n.length).sort();
    expect(degrees).toEqual([1, 1, 2]);
  });

  it("splits crossing segments at their intersection", () => {
    const graph = buildNavGraph(
      [
        { x1: -10, z1: 0, x2: 10, z2: 0 },
        { x1: 0, z1: -10, x2: 0, z2: 10 },
      ],
      [],
    );
    // 4 endpoints + 1 crossing = 5 nodes.
    expect(graph.nodes.length).toBe(5);
    const route = findRoute(graph, { x: -10, z: 0 }, { x: 0, z: 10 });
    expect(route.ok).toBe(true);
    if (route.ok) {
      // Must pass through the crossing (0,0).
      expect(route.waypoints.some((w) => Math.hypot(w.x, w.z) < 0.01)).toBe(true);
      expect(route.distance).toBeCloseTo(20, 6);
    }
  });

  it("skips invalid segments without breaking the graph", () => {
    const graph = buildNavGraph(
      [
        { x1: NaN, z1: 0, x2: 10, z2: 0 },
        { x1: 5, z1: 5, x2: 5, z2: 5 }, // zero length
        { x1: 0, z1: 0, x2: 10, z2: 0 },
      ],
      [],
    );
    expect(graph.nodes.length).toBe(2);
  });

  it("links door nodes to the nearest road nodes", () => {
    const graph = buildNavGraph([...L_ROADS], [{ x: 5, z: 3 }]);
    expect(graph.nodes.length).toBe(4);
    const route = findRoute(graph, { x: 0, z: 0 }, { x: 5, z: 3 });
    expect(route.ok).toBe(true);
    if (route.ok) {
      const last = route.waypoints[route.waypoints.length - 1];
      expect(last?.x).toBeCloseTo(5, 6);
      expect(last?.z).toBeCloseTo(3, 6);
    }
  });

  it("computes street-facing doors from building rotation", () => {
    // Front faces +Z at rotation 0.
    expect(doorForBuilding(10, 20, 0, 6)).toEqual({ x: 10, z: 20 + 3 + 1.5 });
    // rotation π/2 faces +X.
    const door = doorForBuilding(10, 20, Math.PI / 2, 6);
    expect(door.x).toBeCloseTo(10 + 3 + 1.5, 9);
    expect(door.z).toBeCloseTo(20, 9);
  });

  it("clamps points to the valid world square", () => {
    expect(clampToWorld({ x: 999, z: -999 })).toEqual({ x: 240, z: -240 });
    expect(clampToWorld({ x: 3, z: 4 })).toEqual({ x: 3, z: 4 });
  });

  it("signatures are stable until roads change", () => {
    const roads = [...L_ROADS];
    expect(graphSignature(roads, 2)).toBe(graphSignature(roads, 2));
    expect(graphSignature(roads, 2)).not.toBe(graphSignature(roads, 3));
    expect(graphSignature([...roads, { x1: 0, z1: 0, x2: 1, z2: 1 }], 2)).not.toBe(
      graphSignature(roads, 2),
    );
  });
});

describe("route finding", () => {
  it("routes along connected roads with the shortest distance", () => {
    const graph = buildNavGraph([...L_ROADS], []);
    const route = findRoute(graph, { x: 0, z: 0 }, { x: 10, z: 10 });
    expect(route.ok).toBe(true);
    if (route.ok) {
      expect(route.waypoints.length).toBeGreaterThanOrEqual(2);
      expect(route.waypoints[route.waypoints.length - 1]).toEqual({ x: 10, z: 10 });
      expect(route.distance).toBeCloseTo(20, 6);
    }
  });

  it("treats destination == start as already arrived", () => {
    const graph = buildNavGraph([...L_ROADS], []);
    const route = findRoute(graph, { x: 1, z: 1 }, { x: 1 + ARRIVAL_RADIUS / 2, z: 1 });
    expect(route).toEqual({ ok: true, waypoints: [], distance: 0 });
  });

  it("rejects invalid points", () => {
    const graph = buildNavGraph([...L_ROADS], []);
    expect(findRoute(graph, { x: NaN, z: 0 }, { x: 10, z: 10 })).toEqual({
      ok: false,
      reason: "invalid-point",
    });
  });

  it("reports an empty graph", () => {
    expect(findRoute({ nodes: [], neighbors: [] }, { x: 0, z: 0 }, { x: 1, z: 1 })).toEqual({
      ok: false,
      reason: "empty-graph",
    });
  });

  it("reports far starts and goals instead of snapping across the map", () => {
    const graph = buildNavGraph([...L_ROADS], []);
    expect(findRoute(graph, { x: 500, z: 500 }, { x: 10, z: 10 }).ok).toBe(false);
    const far = findRoute(graph, { x: 500, z: 500 }, { x: 10, z: 10 });
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.reason).toBe("no-snap-from");
    const farGoal = findRoute(graph, { x: 0, z: 0 }, { x: -400, z: -400 });
    expect(farGoal.ok).toBe(false);
    if (!farGoal.ok) expect(farGoal.reason).toBe("no-snap-to");
  });

  it("reports disconnected destinations", () => {
    const graph = buildNavGraph(
      [
        { x1: 0, z1: 0, x2: 10, z2: 0 },
        { x1: 1000, z1: 1000, x2: 1010, z2: 1000 },
      ],
      [],
      { maxBridge: 45 },
    );
    const route = findRoute(graph, { x: 0, z: 0 }, { x: 1005, z: 1000 });
    expect(route).toEqual({ ok: false, reason: "disconnected" });
  });

  it("chains far doors through each other toward the roads", () => {
    const roads = [{ x1: 0, z1: 0, x2: 10, z2: 0 }];
    // A block of doors where only the first is near a road.
    const doors = [
      { x: 5, z: 30 },
      { x: 5, z: 60 },
      { x: 5, z: 90 },
    ];
    const graph = buildNavGraph(roads, doors, { maxDoorLink: 120 });
    const route = findRoute(graph, { x: 0, z: 0 }, { x: 5, z: 90 });
    expect(route.ok).toBe(true);
    if (route.ok) {
      const last = route.waypoints[route.waypoints.length - 1];
      expect(last?.x).toBeCloseTo(5, 6);
      expect(last?.z).toBeCloseTo(90, 6);
    }
  });

  it("bridges near-touching networks with a short cut", () => {
    const graph = buildNavGraph(
      [
        { x1: 0, z1: 0, x2: 10, z2: 0 },
        { x1: 30, z1: 0, x2: 40, z2: 0 },
      ],
      [],
      { maxBridge: 45 },
    );
    const route = findRoute(graph, { x: 0, z: 0 }, { x: 40, z: 0 });
    expect(route.ok).toBe(true);
    if (route.ok) expect(route.distance).toBeCloseTo(40, 6);
  });

  it("walks far starts to the nearest road when explicitly allowed", () => {
    const graph = buildNavGraph([...L_ROADS], []);
    const strict = findRoute(graph, { x: 500, z: 0 }, { x: 10, z: 10 });
    expect(strict.ok).toBe(false);
    const allowed = findRoute(graph, { x: 500, z: 0 }, { x: 10, z: 10 }, { allowFarStart: true });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      // First leg reaches the network, then follows roads to the goal.
      expect(allowed.distance).toBeGreaterThan(490);
      const last = allowed.waypoints[allowed.waypoints.length - 1];
      expect(last).toEqual({ x: 10, z: 10 });
    }
  });

  it("is deterministic for identical queries", () => {
    const graph = buildNavGraph([...L_ROADS], [{ x: 5, z: 3 }]);
    const a = findRoute(graph, { x: 0, z: 0 }, { x: 5, z: 3 });
    const b = findRoute(graph, { x: 0, z: 0 }, { x: 5, z: 3 });
    expect(a).toEqual(b);
  });
});
