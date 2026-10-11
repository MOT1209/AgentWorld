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
    bubble: THREE.Mesh;
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
/** Movers keep at least this distance from any other figure. */
export const SEPARATION_GAP = 1.4;
/** Chat bubble appears when a social agent has company this close. */
export const SOCIAL_RADIUS = 9;

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
  private readonly social = new Map<string, boolean>();
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

  /**
   * Marks social intent (backend SOCIALIZING state or SOCIALIZE activity).
   * Shows a chat bubble only while another figure is actually nearby —
   * never a fake conversation.
   */
  setSocial(agentId: string, social: boolean): void {
    if (social) this.social.set(agentId, true);
    else this.social.delete(agentId);
  }

  isSocial(agentId: string): boolean {
    return this.social.get(agentId) ?? false;
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
    this.social.delete(agentId);
  }

  clear(): void {
    for (const id of [...this.movers.keys()]) this.cancelRoute(id);
    this.movers.clear();
    this.base.clear();
    this.social.clear();
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
    this.applySeparation(step);
    this.updateBubbles();
  }

  /**
   * Keeps movers from piling onto each other (or onto bystanders): a soft
   * radial push plus a deterministic sideways bias so head-on pairs slide
   * past instead of jittering. Stationary figures are never moved. No full
   * collision avoidance is claimed.
   */
  private applySeparation(step: number): void {
    const moverIds = [...this.movers.keys()]
      .filter((id) => (this.movers.get(id)?.remaining.length ?? 0) > 0)
      .sort();
    if (moverIds.length === 0) return;
    const positions = new Map<string, { x: number; z: number }>();
    for (const id of new Set([...this.base.keys(), ...this.movers.keys()])) {
      const figure = this.figureOf(id);
      if (figure === undefined) continue;
      positions.set(id, { x: figure.group.position.x, z: figure.group.position.z });
    }
    for (const id of moverIds) {
      const figure = this.figureOf(id);
      const self = positions.get(id);
      const mover = this.movers.get(id);
      if (figure === undefined || self === undefined || mover === undefined) continue;
      const cap = mover.speed * step + 0.05;
      for (const otherId of [...positions.keys()].sort()) {
        if (otherId === id) continue;
        const other = positions.get(otherId);
        if (other === undefined) continue;
        const dx = self.x - other.x;
        const dz = self.z - other.z;
        const d = Math.hypot(dx, dz);
        if (!(d < SEPARATION_GAP) || d < 1e-6) continue;
        const push = Math.min(((SEPARATION_GAP - d) / SEPARATION_GAP) * 0.6, cap);
        const nx = dx / d;
        const nz = dz / d;
        self.x += nx * push + -nz * push * 0.35;
        self.z += nz * push + nx * push * 0.35;
      }
      const totalPush = Math.hypot(self.x - figure.group.position.x, self.z - figure.group.position.z);
      if (totalPush > cap && totalPush > 0) {
        const k = cap / totalPush;
        self.x = figure.group.position.x + (self.x - figure.group.position.x) * k;
        self.z = figure.group.position.z + (self.z - figure.group.position.z) * k;
      }
      figure.group.position.x = self.x;
      figure.group.position.z = self.z;
      positions.set(id, { x: self.x, z: self.z });
    }
  }

  /** Chat bubbles for social agents that actually have company nearby. */
  private updateBubbles(): void {
    const ids = [...new Set([...this.base.keys(), ...this.movers.keys()])].sort();
    const positions = new Map<string, { x: number; z: number }>();
    for (const id of ids) {
      const figure = this.figureOf(id);
      if (figure === undefined) continue;
      positions.set(id, { x: figure.group.position.x, z: figure.group.position.z });
    }
    for (const id of ids) {
      const figure = this.figureOf(id);
      if (figure === undefined) continue;
      const self = positions.get(id);
      let company = false;
      if ((this.social.get(id) ?? false) && self !== undefined) {
        for (const otherId of ids) {
          if (otherId === id) continue;
          const other = positions.get(otherId);
          if (other === undefined) continue;
          if (Math.hypot(self.x - other.x, self.z - other.z) <= SOCIAL_RADIUS) {
            company = true;
            break;
          }
        }
      }
      figure.parts.bubble.visible = company;
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
