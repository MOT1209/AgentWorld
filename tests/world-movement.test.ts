/**
 * Step 3 movement + behavior state machine.
 * Figures are real THREE.Group graphs (headless); no DOM, no renderer.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  MovementSystem,
  baseBehaviorFor,
  angleDelta,
  resetFigurePose,
  DEFAULT_WALK_SPEED,
  type MovableFigure,
} from "../apps/web/src/world/agentMovement.js";

function makeFigure(): MovableFigure {
  const group = new THREE.Group();
  const part = (): THREE.Group => new THREE.Group();
  return {
    group,
    parts: { torso: part(), head: part(), armL: part(), armR: part(), legL: part(), legR: part() },
  };
}

function makeSystem(figures: Map<string, MovableFigure>): {
  system: MovementSystem;
  pins: Array<{ id: string; pinned: boolean }>;
} {
  const pins: Array<{ id: string; pinned: boolean }> = [];
  const system = new MovementSystem(
    (id) => figures.get(id),
    { setPinned: (id, pinned) => pins.push({ id, pinned }) },
  );
  return { system, pins };
}

describe("base behavior mapping (authoritative state is read-only)", () => {
  it("maps every known backend state explicitly", () => {
    expect(baseBehaviorFor("WORKING")).toBe("working");
    expect(baseBehaviorFor("WAITING")).toBe("waiting");
    expect(baseBehaviorFor("OFFLINE")).toBe("unavailable");
    expect(baseBehaviorFor("PAUSED")).toBe("unavailable");
    expect(baseBehaviorFor("ERROR")).toBe("unavailable");
    for (const s of ["IDLE", "ONLINE", "THINKING", "SLEEPING", "RESTING", "SOCIALIZING", "TRAVELING"]) {
      expect(baseBehaviorFor(s)).toBe("idle");
    }
  });

  it("degrades unknown future states to idle", () => {
    expect(baseBehaviorFor("MEDITATING")).toBe("idle");
    expect(baseBehaviorFor("")).toBe("idle");
  });

  it("never reports the base as moving", () => {
    const { system } = makeSystem(new Map());
    system.setBaseBehavior("a", baseBehaviorFor("WORKING"));
    expect(system.baseBehaviorOf("a")).toBe("working");
    expect(system.behaviorOf("unknown")).toBe("idle");
  });
});

describe("movement controller", () => {
  it("moves toward the destination without teleporting", () => {
    const figures = new Map([["a", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.setBaseBehavior("a", "idle");
    system.startRoute("a", [{ x: 10, z: 0 }], { point: { x: 10, z: 0 }, name: "Shop", demo: false });
    expect(system.behaviorOf("a")).toBe("moving");
    const pos = figures.get("a")?.group.position;
    system.update(0.1, 0);
    const after = pos?.x ?? NaN;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(DEFAULT_WALK_SPEED * 0.1 + 1e-9);
    expect(pos?.y).toBe(0);
  });

  it("is frame-rate independent", () => {
    const run = (dts: number[]): number => {
      const figures = new Map([["a", makeFigure()]]);
      const { system } = makeSystem(figures);
      system.startRoute("a", [{ x: 20, z: 5 }], { point: { x: 20, z: 5 }, name: null, demo: false });
      let t = 0;
      for (const dt of dts) {
        t += dt;
        system.update(dt, t);
      }
      const pos = figures.get("a")?.group.position;
      return (pos?.x ?? NaN) + (pos?.z ?? NaN) * 1000;
    };
    const fine = run(new Array(40).fill(0.05));
    const coarse = run(new Array(4).fill(0.5));
    expect(Math.abs(fine - coarse)).toBeLessThan(0.6);
  });

  it("stops exactly at the destination and releases the route", () => {
    const figures = new Map([["a", makeFigure()]]);
    const { system, pins } = makeSystem(figures);
    system.startRoute("a", [{ x: 3, z: 4 }], { point: { x: 3, z: 4 }, name: null, demo: false });
    for (let i = 0; i < 60 && system.hasRoute("a"); i += 1) system.update(0.1, i * 0.1);
    expect(system.hasRoute("a")).toBe(false);
    const pos = figures.get("a")?.group.position;
    expect(pos?.x).toBeCloseTo(3, 9);
    expect(pos?.z).toBeCloseTo(4, 9);
    expect(system.behaviorOf("a")).toBe("idle");
    expect(pins[pins.length - 1]).toEqual({ id: "a", pinned: false });
    // Limbs settle back to neutral.
    expect(figures.get("a")?.parts.legL.rotation.x).toBe(0);
  });

  it("rotates smoothly toward travel direction (no snapping)", () => {
    const figures = new Map([["a", makeFigure()]]);
    const fig = figures.get("a");
    if (fig === undefined) throw new Error("missing figure");
    fig.group.rotation.y = Math.PI; // facing away from +X
    const { system } = makeSystem(figures);
    system.startRoute("a", [{ x: 50, z: 0 }], { point: { x: 50, z: 0 }, name: null, demo: false });
    system.update(0.016, 0);
    const yaw = fig.group.rotation.y;
    // Turned a little toward π/2, but did not snap.
    expect(Math.abs(angleDelta(yaw, Math.PI / 2))).toBeLessThan(Math.PI / 2);
    expect(Math.abs(angleDelta(yaw, Math.PI))).toBeGreaterThan(0.001);
  });

  it("pausing freezes simulation-time movement (rendering untouched)", () => {
    const figures = new Map([["a", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.startRoute("a", [{ x: 50, z: 0 }], { point: { x: 50, z: 0 }, name: null, demo: false });
    system.setPaused(true);
    system.update(1, 1);
    system.update(1, 2);
    expect(figures.get("a")?.group.position.x).toBe(0);
    expect(system.hasRoute("a")).toBe(true);
    system.setPaused(false);
    system.update(0.2, 3);
    expect(figures.get("a")?.group.position.x ?? 0).toBeGreaterThan(0);
  });

  it("skips invalid waypoints instead of exploding", () => {
    const figures = new Map([["a", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.startRoute(
      "a",
      [{ x: NaN, z: NaN }, { x: 4, z: 0 }],
      { point: { x: 4, z: 0 }, name: null, demo: false },
    );
    for (let i = 0; i < 40 && system.hasRoute("a"); i += 1) system.update(0.1, i);
    expect(system.hasRoute("a")).toBe(false);
    expect(figures.get("a")?.group.position.x).toBeCloseTo(4, 9);
  });

  it("moves multiple agents simultaneously", () => {
    const figures = new Map([
      ["a", makeFigure()],
      ["b", makeFigure()],
    ]);
    const { system } = makeSystem(figures);
    system.startRoute("a", [{ x: 10, z: 0 }], { point: { x: 10, z: 0 }, name: null, demo: false });
    system.startRoute("b", [{ x: 0, z: 10 }], { point: { x: 0, z: 10 }, name: null, demo: false });
    expect(system.moverCount()).toBe(2);
    system.update(0.5, 0.5);
    expect(figures.get("a")?.group.position.x ?? 0).toBeGreaterThan(0);
    expect(figures.get("b")?.group.position.z ?? 0).toBeGreaterThan(0);
  });

  it("replaces routes without duplicating controllers", () => {
    const figures = new Map([["a", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.startRoute("a", [{ x: 100, z: 0 }], { point: { x: 100, z: 0 }, name: null, demo: false });
    system.update(0.1, 0);
    system.startRoute("a", [{ x: 0, z: 100 }], { point: { x: 0, z: 100 }, name: null, demo: false });
    expect(system.moverCount()).toBe(1);
    expect(system.destinationOf("a")?.point).toEqual({ x: 0, z: 100 });
  });

  it("drops movers whose figure vanished (safe removal)", () => {
    const figures = new Map([["a", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.startRoute("a", [{ x: 100, z: 0 }], { point: { x: 100, z: 0 }, name: null, demo: false });
    figures.delete("a");
    expect(() => system.update(0.1, 0)).not.toThrow();
    expect(system.moverCount()).toBe(0);
  });
});

describe("state machine transitions", () => {
  it("arrival returns to the authority-derived base", () => {
    const figures = new Map([["w", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.setBaseBehavior("w", "working");
    system.startRoute("w", [{ x: 2, z: 0 }], { point: { x: 2, z: 0 }, name: null, demo: false });
    expect(system.behaviorOf("w")).toBe("moving");
    for (let i = 0; i < 30 && system.hasRoute("w"); i += 1) system.update(0.1, i);
    expect(system.behaviorOf("w")).toBe("working");
  });

  it("unavailable agents refuse and cancel routes", () => {
    const figures = new Map([["u", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.startRoute("u", [{ x: 10, z: 0 }], { point: { x: 10, z: 0 }, name: null, demo: false });
    expect(system.hasRoute("u")).toBe(true);
    system.setBaseBehavior("u", "unavailable");
    expect(system.hasRoute("u")).toBe(false);
    expect(system.behaviorOf("u")).toBe("unavailable");
    system.startRoute("u", [{ x: 10, z: 0 }], { point: { x: 10, z: 0 }, name: null, demo: false });
    expect(system.hasRoute("u")).toBe(false);
  });

  it("cancelRoute releases the figure and neutralizes the pose", () => {
    const figures = new Map([["c", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.startRoute("c", [{ x: 100, z: 0 }], { point: { x: 100, z: 0 }, name: null, demo: false });
    system.update(0.2, 0.2);
    expect(Math.abs(figures.get("c")?.parts.legL.rotation.x ?? 0)).toBeGreaterThan(0.01);
    system.cancelRoute("c");
    expect(system.hasRoute("c")).toBe(false);
    expect(figures.get("c")?.parts.legL.rotation.x).toBe(0);
  });

  it("remove() clears base state and routes together", () => {
    const figures = new Map([["r", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.setBaseBehavior("r", "working");
    system.startRoute("r", [{ x: 10, z: 0 }], { point: { x: 10, z: 0 }, name: null, demo: false });
    system.remove("r");
    expect(system.hasRoute("r")).toBe(false);
    expect(system.behaviorOf("r")).toBe("idle");
  });

  it("working figures hold a distinct task pose", () => {
    const figures = new Map([["w", makeFigure()]]);
    const { system } = makeSystem(figures);
    system.setBaseBehavior("w", "working");
    system.update(0.1, 1);
    expect(figures.get("w")?.parts.armL.rotation.x ?? 0).toBeLessThan(-0.3);
  });
});

describe("pose helpers", () => {
  it("angleDelta takes the shortest arc", () => {
    expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(angleDelta(0, 3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(angleDelta(Math.PI, -Math.PI)).toBeCloseTo(0, 9);
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2, 9);
  });

  it("resetFigurePose neutralizes every limb", () => {
    const figure = makeFigure();
    figure.parts.legL.rotation.x = 0.5;
    figure.parts.armR.rotation.x = -0.4;
    figure.parts.torso.rotation.x = 0.2;
    resetFigurePose(figure);
    expect(figure.parts.legL.rotation.x).toBe(0);
    expect(figure.parts.armR.rotation.x).toBe(0);
    expect(figure.parts.torso.rotation.x).toBe(0);
  });
});
