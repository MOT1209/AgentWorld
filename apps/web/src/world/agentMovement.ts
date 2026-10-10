/**
 * Step 3 movement + behavior for the Step 2 characters.
 *
 * Two layers stay strictly separate:
 *
 * 1. Authoritative application state (backend `state`, `locationId`,
 *    activity) is READ ONLY here. It maps to a *base* behavior and decides
 *    *where* an agent belongs. It is never rewritten to suit the animation.
 * 2. Local simulation state (route, waypoints, walk phase, pose) lives in
 *    `MovementSystem` and is driven by one centralized `update()` call from
 *    the existing render loop — never one timer per agent.
 *
 * When the backend moves an agent (new `locationId`), the view hands this
 * system a road-following route; the character walks it instead of lerping
 * through buildings. Pinned agents skip the manager's placement ease while
 * a route is active.
 */

import type * as THREE from "three";
import { ARRIVAL_RADIUS, type NavPoint } from "./navigation.js";

export type BehaviorState = "idle" | "moving" | "working" | "waiting" | "unavailable";

/** Base behaviors (never "moving" — motion comes from an active route). */
export type BaseBehavior = Exclude<BehaviorState, "moving">;

/**
 * Maps the authoritative backend agent state to a local base behavior.
 * Unknown future states degrade to idle rather than freezing the world.
 */
export function baseBehaviorFor(backendState: string): BaseBehavior {
  switch (backendState) {
    case "WORKING":
      return "working";
    case "WAITING":
      return "waiting";
    case "OFFLINE":
    case "PAUSED":
    case "ERROR":
      return "unavailable";
    default:
      return "idle";
  }
}

/** Minimal figure surface (a structural subset of BuiltCharacter). */
export interface MovableFigure {
  group: THREE.Group;
  parts: {
    torso: THREE.Group;
    head: THREE.Group;
    armL: THREE.Group;
    armR: THREE.Group;
    legL: THREE.Group;
    legR: THREE.Group;
  };
}

/** Pin sink so movers own their position (satisfied by CharacterManager). */
export interface PinSink {
  setPinned(agentId: string, pinned: boolean): void;
}

export interface RouteDestination {
  point: NavPoint;
  /** Human label for the inspector (location name, plaza, …). */
  name: string | null;
  /** True for local demo-stroll goals (never a backend task). */
  demo: boolean;
}

interface Mover {
  remaining: NavPoint[];
  speed: number;
  walkPhase: number;
  destination: RouteDestination;
}

export const DEFAULT_WALK_SPEED = 5;
const MAX_TURN_RATE = 5.5;
const WALK_SWING = 0.55;
const ARM_SWING = 0.38;

/** Shortest signed arc from `from` to `to` (radians, -π..π). */
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Returns limbs to neutral (used when a route ends or is cancelled). */
export function resetFigurePose(figure: MovableFigure): void {
  figure.parts.legL.rotation.x = 0;
  figure.parts.legR.rotation.x = 0;
  figure.parts.armL.rotation.x = 0;
  figure.parts.armR.rotation.x = 0;
  figure.parts.torso.rotation.x = 0;
}

export class MovementSystem {
  private readonly movers = new Map<string, Mover>();
  private readonly base = new Map<string, BaseBehavior>();
  private paused = false;
  private timeScale = 1;

  constructor(
    private readonly figureOf: (agentId: string) => MovableFigure | undefined,
    private readonly pins: PinSink,
  ) {}

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setTimeScale(scale: number): void {
    if (Number.isFinite(scale) && scale >= 0) this.timeScale = Math.min(scale, 8);
  }

  timeScaleValue(): number {
    return this.timeScale;
  }

  /** Records the authority-derived base behavior (never "moving"). */
  setBaseBehavior(agentId: string, behavior: BaseBehavior): void {
    this.base.set(agentId, behavior);
    if (behavior === "unavailable") this.cancelRoute(agentId);
  }

  baseBehaviorOf(agentId: string): BaseBehavior {
    return this.base.get(agentId) ?? "idle";
  }

  /** Effective behavior: an active route reads as moving (unless unavailable). */
  behaviorOf(agentId: string): BehaviorState {
    const base = this.base.get(agentId) ?? "idle";
    if (base === "unavailable") return "unavailable";
    return this.movers.has(agentId) ? "moving" : base;
  }

  hasRoute(agentId: string): boolean {
    return this.movers.has(agentId);
  }

  destinationOf(agentId: string): RouteDestination | undefined {
    return this.movers.get(agentId)?.destination;
  }

  moverCount(): number {
    return this.movers.size;
  }

  /**
   * Starts (or replaces) a route. Empty waypoint lists arrive immediately.
   * Unavailable agents refuse new routes.
   */
  startRoute(
    agentId: string,
    waypoints: readonly NavPoint[],
    destination: RouteDestination,
    speed = DEFAULT_WALK_SPEED,
  ): void {
    if ((this.base.get(agentId) ?? "idle") === "unavailable") return;
    const figure = this.figureOf(agentId);
    if (figure === undefined) return;
    this.cancelRoute(agentId);
    if (waypoints.length === 0) return; // already there
    this.movers.set(agentId, {
      remaining: waypoints.map((w) => ({ x: w.x, z: w.z })),
      speed: speed > 0 ? speed : DEFAULT_WALK_SPEED,
      walkPhase: 0,
      destination,
    });
    this.pins.setPinned(agentId, true);
  }

  /** Cancels a route and releases the figure back to placement easing. */
  cancelRoute(agentId: string): void {
    if (!this.movers.has(agentId)) return;
    this.movers.delete(agentId);
    const figure = this.figureOf(agentId);
    if (figure !== undefined) resetFigurePose(figure);
    this.pins.setPinned(agentId, false);
  }

  /** Full cleanup for a confirmed-deleted agent. */
  remove(agentId: string): void {
    this.cancelRoute(agentId);
    this.base.delete(agentId);
  }

  clear(): void {
    for (const id of [...this.movers.keys()]) this.cancelRoute(id);
    this.movers.clear();
    this.base.clear();
  }

  /**
   * Advances every mover and applies walk/work poses. Poses override the
   * manager's idle pass (which runs first); movers that vanish mid-frame or
   * invalid waypoints are dropped safely, never thrown.
   */
  update(deltaSeconds: number, timeSeconds: number): void {
    const step = this.paused ? 0 : deltaSeconds * this.timeScale;
    if (!(step > 0)) return;
    for (const [id, mover] of [...this.movers]) {
      const figure = this.figureOf(id);
      if (figure === undefined) {
        this.movers.delete(id);
        this.pins.setPinned(id, false);
        continue;
      }
      this.stepMover(figure, mover, step);
      if (mover.remaining.length === 0) {
        // Arrived: release and settle into the base pose.
        this.movers.delete(id);
        resetFigurePose(figure);
        this.pins.setPinned(id, false);
        continue;
      }
      this.applyWalkPose(figure, mover, step);
    }
    // Working figures hold a restrained task pose (idle pass runs first).
    for (const [id, base] of this.base) {
      if (base !== "working" || this.movers.has(id)) continue;
      const figure = this.figureOf(id);
      if (figure === undefined) continue;
      this.applyWorkPose(figure.parts, timeSeconds);
    }
  }

  private stepMover(figure: MovableFigure, mover: Mover, step: number): void {
    const pos = figure.group.position;
    const maxStep = mover.speed * step;
    let target = mover.remaining[0];
    if (target === undefined) return;
    if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) {
      mover.remaining.shift();
      target = mover.remaining[0];
      if (target === undefined) return;
    }
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const distance = Math.hypot(dx, dz);
    // Snap only within one frame's travel (plus a hair) — never teleport.
    if (distance <= Math.max(ARRIVAL_RADIUS, maxStep + 1e-6)) {
      pos.x = target.x;
      pos.z = target.z;
      mover.remaining.shift();
      return;
    }
    const nx = dx / distance;
    const nz = dz / distance;
    pos.x += nx * maxStep;
    pos.z += nz * maxStep;
    pos.y = 0;
    const desiredYaw = Math.atan2(nx, nz);
    const turn = angleDelta(figure.group.rotation.y, desiredYaw);
    const maxTurn = MAX_TURN_RATE * step;
    figure.group.rotation.y += Math.max(-maxTurn, Math.min(maxTurn, turn));
  }

  private applyWalkPose(figure: MovableFigure, mover: Mover, step: number): void {
    mover.walkPhase += step * mover.speed * 1.6;
    const swing = Math.sin(mover.walkPhase);
    figure.parts.legL.rotation.x = swing * WALK_SWING;
    figure.parts.legR.rotation.x = -swing * WALK_SWING;
    figure.parts.armL.rotation.x = -swing * ARM_SWING;
    figure.parts.armR.rotation.x = swing * ARM_SWING;
    figure.parts.torso.position.y = 0.75 + Math.abs(Math.cos(mover.walkPhase)) * 0.03;
    figure.parts.torso.rotation.x = 0.05;
  }

  private applyWorkPose(
    parts: MovableFigure["parts"],
    timeSeconds: number,
  ): void {
    const bob = Math.sin(timeSeconds * 2.2);
    parts.armL.rotation.x = -0.55 + bob * 0.07;
    parts.armR.rotation.x = -0.55 - bob * 0.07;
    parts.head.rotation.x = 0.14 + Math.sin(timeSeconds * 1.1) * 0.03;
    parts.legL.rotation.x = 0;
    parts.legR.rotation.x = 0;
  }
}
