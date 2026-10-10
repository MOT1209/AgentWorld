/**
 * Simulation engine.
 *
 * The engine is the ONLY thing that advances the world on a heartbeat. Every
 * tick is deliberately cheap and does not call a model:
 *
 *   1. advance simulated time (world.service.tickWorld, persisted and idempotent)
 *   2. activate planned activities and complete ones that are due
 *   3. decay/recover needs by the simulated minutes that elapsed
 *   4. when an agent has nothing open, ask the decision engine what to do
 *   5. execute that proposal through the SAME ActionValidator operators use
 *   6. for each completed activity: award skill XP, advance an active goal,
 *      record an episodic memory
 *
 * Failure isolation is a requirement, not a nicety: one agent throwing must not
 * stop the others, and a rejected decision is logged rather than crashing the
 * tick. If the AI provider or the 3D view is unavailable, this loop is
 * unaffected because it uses neither.
 */
import {
  actorSystem,
  canTransitionAgentState,
  computeSimulatedTime,
  dailyPhase,
  logger,
  newCorrelationId,
  OPEN_ACTIVITY_STATUSES,
  type ActivityType,
  type ActorRef,
  type AgentState,
  type NeedType,
} from "../../shared/src/index.js";
import { prisma, type DbClient } from "../../database/src/index.js";
import type { Agent, AgentState as AgentStateRow } from "../../database/src/types.js";
import type { World } from "../../database/src/types.js";
import { getActiveWorld, requireWorld, tickWorld } from "../../world/src/index.js";
import { changeAgentState } from "../../agents/src/index.js";
import { pruneExpiredMemories, storeMemory } from "../../memory/src/index.js";
import { advanceActiveGoal } from "./goals.js";
import { activateActivity, completeActivity, getOpenActivity } from "./activities.js";
import { applyNeedsTick, criticalNeeds, parseVitals, serializeVitals } from "./needs.js";
import {
  grantSkillExperience,
  parseSkills,
  serializeSkills,
  skillForActivity,
  xpForActivity,
} from "./skills.js";
import { decisionEngine, type Decision } from "./decision.js";
import { ACTIVITY_STATE, executeAction, type AgentAction } from "./actions.js";
import { controlWorld, type WorldControlAction } from "./clock.js";
import { evaluateAgentRoutines } from "./routines.js";
import { runPayrollCycle, payrollDayKey } from "../../economy/src/index.js";

export const DEFAULT_TICK_INTERVAL_MS = 5_000;
export const DEFAULT_MAX_AGENTS_PER_TICK = 200;
/** Percent of a goal advanced by completing one WORK activity. */
export const WORK_ACTIVITY_GOAL_PROGRESS = 5;

export interface SimulationEngineOptions {
  tickIntervalMs?: number;
  /** Injectable clock. Tests pass a fixed one for deterministic ticks. */
  now?: () => Date;
  maxAgentsPerTick?: number;
  /** Prune expired memories every N ticks. 0 disables housekeeping. */
  housekeepingEveryTicks?: number;
}

export interface TickResult {
  worldId: string | null;
  skipped: boolean;
  reason?: string;
  simulatedNow?: string;
  elapsedSimMinutes?: number;
  agentsProcessed: number;
  activitiesCompleted: number;
  decisionsExecuted: number;
  decisionRejected: number;
  routinesTriggered: number;
  routinesSkipped: number;
  /** Set only on ticks that advanced into a new simulated day. */
  payroll?: { paid: number; replayed: number; shortfalls: number; simulatedDay: string };
  errors: Array<{ agentId: string; message: string }>;
}

export interface AgentSimulationSummary {
  id: string;
  name: string;
  roleKey: string;
  title: string;
  state: string;
  locationId: string | null;
  activity: {
    id: string;
    type: string;
    status: string;
    startTime: string;
    expectedEndTime: string | null;
  } | null;
  needs: Record<NeedType, number>;
  critical: NeedType[];
}

export interface SimulationState {
  world: {
    id: string;
    name: string;
    status: string;
    timeScale: number;
    timeOffsetMinutes: number;
    lastTickAt: string | null;
  };
  simulatedNow: string;
  wallNow: string;
  phase: string;
  engine: { heartbeatRunning: boolean; busy: boolean; tickIntervalMs: number };
  counts: { agents: number; activeActivities: number; criticalNeeds: number };
  agents: AgentSimulationSummary[];
}

interface Landmark {
  id: string;
  name: string;
  kind: string;
}

type AgentWithState = Agent & { state: AgentStateRow | null };

function resolveTickInterval(options: SimulationEngineOptions): number {
  if (options.tickIntervalMs !== undefined && options.tickIntervalMs > 0) return options.tickIntervalMs;
  const fromEnv = Number(process.env.SIMULATION_TICK_MS ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 250) return fromEnv;
  return DEFAULT_TICK_INTERVAL_MS;
}

export class SimulationEngine {
  readonly tickIntervalMs: number;
  private readonly db: DbClient;
  private readonly now: () => Date;
  private readonly maxAgentsPerTick: number;
  private readonly housekeepingEveryTicks: number;
  private readonly log = logger.child({ component: "simulation.engine" });
  private readonly actor = actorSystem("simulation-engine");
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private tickCount = 0;
  /**
   * Rejection-log throttle: a deterministic engine can propose the same
   * impossible action on every tick, which used to write one identical
   * warning per agent per tick (hundreds of lines per hour).
   */
  private readonly rejectionLog = new Map<string, { tick: number; suppressed: number }>();
  private static readonly REJECTION_LOG_EVERY_TICKS = 60;
  private lastPayrollDay: string | null = null;

  constructor(db: DbClient, options: SimulationEngineOptions = {}) {
    this.db = db;
    this.tickIntervalMs = resolveTickInterval(options);
    this.now = options.now ?? (() => new Date());
    this.maxAgentsPerTick = options.maxAgentsPerTick ?? DEFAULT_MAX_AGENTS_PER_TICK;
    this.housekeepingEveryTicks = options.housekeepingEveryTicks ?? 12;
  }

  get isHeartbeatRunning(): boolean {
    return this.timer !== null;
  }

  get isBusy(): boolean {
    return this.ticking;
  }

  // -- Lifecycle -------------------------------------------------------------

  async start(worldId?: string): Promise<World> {
    const world = await controlWorldSafely(this.db, "start", this.actor, worldId);
    this.ensureHeartbeat();
    return world;
  }

  async pause(worldId?: string): Promise<World> {
    return controlWorldSafely(this.db, "pause", this.actor, worldId);
  }

  async resume(worldId?: string): Promise<World> {
    const world = await controlWorldSafely(this.db, "resume", this.actor, worldId);
    this.ensureHeartbeat();
    return world;
  }

  async stop(worldId?: string): Promise<World> {
    return controlWorldSafely(this.db, "stop", this.actor, worldId);
  }

  /** Starts the interval that calls tick(). Idempotent. */
  ensureHeartbeat(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.log.error("Simulation tick crashed", {
          action: "simulation.tick_failed",
          result: "ERROR",
          error,
        });
      });
    }, this.tickIntervalMs);
    // Never keep the process alive just for the simulation.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -- Tick ------------------------------------------------------------------

  async tick(options: { at?: Date; worldId?: string } = {}): Promise<TickResult> {
    const empty: TickResult = {
      worldId: null,
      skipped: true,
      agentsProcessed: 0,
      activitiesCompleted: 0,
      decisionsExecuted: 0,
      decisionRejected: 0,
      routinesTriggered: 0,
      routinesSkipped: 0,
      errors: [],
    };

    if (this.ticking) return { ...empty, reason: "tick-in-progress" };
    this.ticking = true;

    try {
      const world =
        options.worldId === undefined
          ? await getActiveWorld(this.db)
          : await requireWorld(this.db, options.worldId);

      if (world.status !== "RUNNING") {
        return { ...empty, worldId: world.id, reason: `world-${world.status.toLowerCase()}` };
      }

      const before = world.timeOffsetMinutes;
      const at = options.at ?? this.now();
      const { world: updated, simulated } = await tickWorld(this.db, world.id, at);
      const elapsedSimMinutes = updated.timeOffsetMinutes - before;
      if (!(elapsedSimMinutes > 0)) {
        return { ...empty, worldId: updated.id, reason: "no-elapsed-sim-time" };
      }

      const agents = await this.db.agent.findMany({
        where: { worldId: updated.id, isActive: true },
        include: { state: true },
        orderBy: { createdAt: "asc" },
        take: this.maxAgentsPerTick,
      });
      const landmarks = await this.loadLandmarks(updated.id);
      const correlationId = newCorrelationId();

      let agentsProcessed = 0;
      let activitiesCompleted = 0;
      let decisionsExecuted = 0;
      let decisionRejected = 0;
      let routinesTriggered = 0;
      let routinesSkipped = 0;
      let payroll: TickResult["payroll"];
      const errors: Array<{ agentId: string; message: string }> = [];

      for (const agent of agents) {
        try {
          const outcome = await this.tickAgent(
            agent,
            simulated.simulatedNow,
            elapsedSimMinutes,
            updated.id,
            landmarks,
            correlationId,
          );
          if (outcome === null) continue;
          agentsProcessed += 1;
          activitiesCompleted += outcome.activitiesCompleted;
          decisionsExecuted += outcome.decisionsExecuted;
          decisionRejected += outcome.decisionRejected;
          routinesTriggered += outcome.routinesTriggered;
          routinesSkipped += outcome.routinesSkipped;
        } catch (error) {
          // One agent failing must never stop the rest of the world.
          errors.push({
            agentId: agent.id,
            message: error instanceof Error ? error.message : String(error),
          });
          this.log.error("Simulation tick failed for one agent", {
            action: "simulation.agent_tick_failed",
            result: "ERROR",
            agentId: agent.id,
            error,
          });
        }
      }

      this.tickCount += 1;
      if (this.housekeepingEveryTicks > 0 && this.tickCount % this.housekeepingEveryTicks === 0) {
        try {
          await pruneExpiredMemories(this.db);
        } catch (error) {
          this.log.warn("Memory housekeeping failed", { action: "simulation.housekeeping_failed", error });
        }
      }

      // Payroll runs once per simulated day, on the first tick that crosses
      // the day boundary. The idempotency key (company, agent, day) makes a
      // repeated pass a no-op even if this in-memory guard is lost.
      const payrollResult = await this.runPayrollIfNewDay(simulated.simulatedNow, correlationId);
      if (payrollResult !== undefined) {
        payroll = payrollResult;
      }

      return {
        worldId: updated.id,
        skipped: false,
        simulatedNow: simulated.simulatedNow.toISOString(),
        elapsedSimMinutes,
        agentsProcessed,
        activitiesCompleted,
        decisionsExecuted,
        decisionRejected,
        routinesTriggered,
        routinesSkipped,
        payroll,
        errors,
      };
    } finally {
      this.ticking = false;
    }
  }

  private async tickAgent(
    agent: AgentWithState,
    simulatedNow: Date,
    elapsedSimMinutes: number,
    worldId: string,
    landmarks: { work: Landmark[]; common: Landmark[] },
    correlationId: string,
  ): Promise<{
    activitiesCompleted: number;
    decisionsExecuted: number;
    decisionRejected: number;
    routinesTriggered: number;
    routinesSkipped: number;
  } | null> {
    const state = agent.state;
    if (state === null) return null;
    if (state.state === "OFFLINE" || state.state === "PAUSED" || state.state === "ERROR") return null;

    const ctx = { actor: this.actor, correlationId, worldId };
    let activitiesCompleted = 0;
    let decisionsExecuted = 0;
    let decisionRejected = 0;
    let routinesTriggered = 0;
    let routinesSkipped = 0;
    let open = await getOpenActivity(this.db, agent.id);

    // 2a. A PLANNED activity whose start time arrived becomes ACTIVE.
    if (open !== null && open.status === "PLANNED" && open.startTime.getTime() <= simulatedNow.getTime()) {
      open = await activateActivity(this.db, open.id, ctx);
    }

    // 2b. An ACTIVE activity that reached its expected end completes.
    if (
      open !== null &&
      open.status === "ACTIVE" &&
      open.expectedEndTime !== null &&
      open.expectedEndTime.getTime() <= simulatedNow.getTime()
    ) {
      const { activity, durationSimMinutes } = await completeActivity(this.db, open.id, ctx, {
        actualEndTime: simulatedNow,
      });
      await this.applyCompletion(agent, activity.type as ActivityType, durationSimMinutes, worldId, correlationId);
      await this.transition(agent.id, state.state, "IDLE", "activity completed");
      activitiesCompleted += 1;
      open = null;
    }

    // 3. Needs: decay/recovery for the simulated minutes that elapsed.
    const vitals = parseVitals(state.vitals);
    const activityType: ActivityType | null =
      open !== null && open.status === "ACTIVE" ? (open.type as ActivityType) : null;
    const { needs, changed } = applyNeedsTick(vitals, activityType, elapsedSimMinutes);
    if (changed.length > 0) {
      await this.db.agentState.update({
        where: { agentId: agent.id },
        data: { vitals: serializeVitals({ needs, updatedAt: simulatedNow.toISOString() }) },
      });
    }

    // 4/5. Decide and execute only when the agent is free.
    if (open === null) {
      // 4a. A due routine fires before the decision engine: routines are the
      // deterministic schedule, decisions only fill what the day does not plan.
      const routineEval = await evaluateAgentRoutines(
        this.db,
        { agentId: agent.id, simulatedNow },
        ctx,
      );
      if (routineEval.triggered.length > 0) {
        routinesTriggered += routineEval.triggered.length;
        routinesSkipped += routineEval.skipped.length;
        return { activitiesCompleted, decisionsExecuted, decisionRejected, routinesTriggered, routinesSkipped };
      }
      routinesSkipped += routineEval.skipped.length;

      const decision = decisionEngine.decide({
        agentId: agent.id,
        state: state.state as AgentState,
        needs,
        phase: dailyPhase(simulatedNow),
        hasOpenActivity: false,
        currentLocationId: agent.currentLocationId,
        workLocationId: this.pickWorkLocation(agent, landmarks.work),
        commonLocationId: landmarks.common[0]?.id ?? null,
      });

      // The proposal is legalized before it reaches the validator: see
      // legalizeDecision for why a reachable state matters.
      const executable = legalizeDecision(decision, state.state as AgentState);
      const action = decisionToAction(executable);
      if (action !== null) {
        try {
          await executeAction(this.db, agent.id, action, {
            actor: this.actor,
            correlationId,
            worldId,
            now: simulatedNow,
          });
          decisionsExecuted += 1;
        } catch (error) {
          // A decision the validator rejects is a normal outcome, not a crash
          // -- and a repeated identical rejection is logged at most once per
          // REJECTION_LOG_EVERY_TICKS, with the suppressed count carried on the
          // next line.
          decisionRejected += 1;
          const key = `${agent.id}:${decision.action}`;
          const previous = this.rejectionLog.get(key);
          if (
            previous === undefined ||
            this.tickCount - previous.tick >= SimulationEngine.REJECTION_LOG_EVERY_TICKS
          ) {
            this.log.warn("Decision rejected by the action validator", {
              action: "simulation.decision_rejected",
              agentId: agent.id,
              decision: decision.action,
              reason: decision.reason,
              suppressedSinceLast: previous?.suppressed ?? 0,
              error,
            });
            this.rejectionLog.set(key, { tick: this.tickCount, suppressed: 0 });
          } else {
            this.rejectionLog.set(key, { tick: previous.tick, suppressed: previous.suppressed + 1 });
          }
        }
      } else if (state.state !== "IDLE" && canTransitionAgentState(state.state as AgentState, "IDLE")) {
        await this.transition(agent.id, state.state, "IDLE", decision.reason);
      }
    }

    return { activitiesCompleted, decisionsExecuted, decisionRejected, routinesTriggered, routinesSkipped };
  }

  /**
   * Daily payroll pass. Fires on the first tick of a new simulated day;
   * ledger-side idempotency keys make a repeated pass a no-op.
   */
  private async runPayrollIfNewDay(
    simulatedNow: Date,
    correlationId: string,
  ): Promise<TickResult["payroll"]> {
    const day = payrollDayKey(simulatedNow);
    if (this.lastPayrollDay === day) return undefined;
    this.lastPayrollDay = day;
    try {
      const cycle = await runPayrollCycle(
        this.db,
        { simulatedNow },
        { actor: this.actor, correlationId },
      );
      if (cycle.paid.length > 0 || cycle.shortfalls.length > 0) {
        this.log.info("Daily payroll ran", {
          action: "economy.payroll_cycle",
          simulatedDay: cycle.simulatedDay,
          paid: cycle.paid.length,
          replayed: cycle.paid.filter((p) => p.replayed).length,
          shortfalls: cycle.shortfalls.length,
        });
      }
      return {
        simulatedDay: cycle.simulatedDay,
        paid: cycle.paid.length,
        replayed: cycle.paid.filter((p) => p.replayed).length,
        shortfalls: cycle.shortfalls.length,
      };
    } catch (error) {
      // Payroll failing must never stop the world ticking.
      this.log.error("Daily payroll failed", {
        action: "economy.payroll_failed",
        result: "ERROR",
        simulatedDay: day,
        error,
      });
      return { simulatedDay: day, paid: 0, replayed: 0, shortfalls: 0 };
    }
  }


  /** Completing an activity has consequences beyond the row's status. */
  private async applyCompletion(
    agent: AgentWithState,
    activityType: ActivityType,
    durationSimMinutes: number,
    worldId: string,
    correlationId: string,
  ): Promise<void> {
    const ctx = { actor: this.actor, correlationId, worldId };

    const skills = parseSkills(agent.skills);
    const skillName = skillForActivity(activityType, skills);
    if (skillName !== null) {
      const result = grantSkillExperience(skills, skillName, xpForActivity(durationSimMinutes));
      await this.db.agent.update({
        where: { id: agent.id },
        data: { skills: serializeSkills(result.skills) },
      });
      if (result.leveledUp) {
        this.log.info("Agent skill levelled up", {
          action: "simulation.skill_level_up",
          agentId: agent.id,
          skill: result.skill.name,
          level: result.skill.level,
        });
      }
    }

    if (activityType === "WORK") {
      await advanceActiveGoal(this.db, agent.id, WORK_ACTIVITY_GOAL_PROGRESS, ctx);
    }

    await storeMemory(
      this.db,
      {
        agentId: agent.id,
        kind: "EPISODIC",
        content: `Completed a ${activityType} activity over ${Math.round(durationSimMinutes)} simulated minutes.`,
        importance: activityType === "WORK" ? 5 : 3,
        source: "EVENT",
      },
      ctx,
    );
  }

  /** Guarded state change: an illegal transition is logged and skipped. */
  private async transition(
    agentId: string,
    from: string,
    to: AgentState,
    reason: string,
  ): Promise<void> {
    const parsedFrom = from as AgentState;
    if (parsedFrom === to) return;
    if (!canTransitionAgentState(parsedFrom, to)) {
      this.log.warn("Refused an illegal agent state transition", {
        action: "simulation.transition_refused",
        agentId,
        fromState: from,
        toState: to,
        reason,
      });
      return;
    }
    await changeAgentState(
      this.db,
      { agentId, state: to, reason },
      { actor: this.actor, worldId: undefined },
    );
  }

  private async loadLandmarks(worldId: string): Promise<{ work: Landmark[]; common: Landmark[] }> {
    const locations = await this.db.location.findMany({
      where: { city: { worldId } },
      select: { id: true, name: true, kind: true },
      orderBy: { name: "asc" },
    });
    return {
      work: locations.filter((location) => location.kind === "OFFICE" || location.kind === "HQ"),
      common: locations.filter(
        (location) =>
          location.kind === "PUBLIC_SPACE" ||
          location.kind === "RESTAURANT" ||
          location.kind === "MARKET",
      ),
    };
  }

  /** Prefers a workspace named after the agent; falls back to the first one. */
  private pickWorkLocation(agent: AgentWithState, workLocations: Landmark[]): string | null {
    const name = agent.name.toLowerCase();
    const named = workLocations.find((location) => location.name.toLowerCase().startsWith(name));
    return named?.id ?? workLocations[0]?.id ?? null;
  }

  // -- Observation -----------------------------------------------------------

  async getState(worldId?: string): Promise<SimulationState> {
    const world =
      worldId === undefined ? await getActiveWorld(this.db) : await requireWorld(this.db, worldId);
    const simulated = computeSimulatedTime(world);

    const agents = await this.db.agent.findMany({
      where: { worldId: world.id },
      include: { state: true },
      orderBy: { createdAt: "asc" },
    });

    const openActivities = await this.db.agentActivity.findMany({
      where: {
        agentId: { in: agents.map((agent) => agent.id) },
        status: { in: [...OPEN_ACTIVITY_STATUSES] },
      },
    });
    const activityByAgent = new Map(openActivities.map((activity) => [activity.agentId, activity]));

    let criticalCount = 0;
    const summaries: AgentSimulationSummary[] = agents.map((agent) => {
      const needs = parseVitals(agent.state?.vitals).needs;
      const critical = criticalNeeds(needs);
      criticalCount += critical.length;
      const activity = activityByAgent.get(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        roleKey: agent.roleKey,
        title: agent.title,
        state: agent.state?.state ?? "UNKNOWN",
        locationId: agent.currentLocationId,
        activity:
          activity === undefined
            ? null
            : {
                id: activity.id,
                type: activity.type,
                status: activity.status,
                startTime: activity.startTime.toISOString(),
                expectedEndTime: activity.expectedEndTime?.toISOString() ?? null,
              },
        needs,
        critical,
      };
    });

    return {
      world: {
        id: world.id,
        name: world.name,
        status: world.status,
        timeScale: world.timeScale,
        timeOffsetMinutes: world.timeOffsetMinutes,
        lastTickAt: world.lastTickAt?.toISOString() ?? null,
      },
      simulatedNow: simulated.simulatedNow.toISOString(),
      wallNow: simulated.wallNow.toISOString(),
      phase: simulated.phase,
      engine: {
        heartbeatRunning: this.isHeartbeatRunning,
        busy: this.isBusy,
        tickIntervalMs: this.tickIntervalMs,
      },
      counts: {
        agents: agents.length,
        activeActivities: openActivities.filter((activity) => activity.status === "ACTIVE").length,
        criticalNeeds: criticalCount,
      },
      agents: summaries,
    };
  }
}

/**
 * Turns a decision the state machine cannot honour into its legal first step.
 *
 * The lifecycle forbids WORKING -> RESTING (and WORKING -> SLEEPING), so an
 * engine that proposes "rest now" to a working agent produced a decision the
 * ActionValidator refused on every single tick: the need stayed critical
 * forever and the log filled with identical rejections. Every state can reach
 * IDLE, so an unreachable activity start is downgraded to "go idle first" and
 * the next tick starts the activity from there.
 */
export function legalizeDecision(decision: Decision, current: AgentState): Decision {
  if (decision.action !== "REST" && decision.action !== "START_ACTIVITY") return decision;
  const activityType: ActivityType | undefined =
    decision.action === "REST" ? "REST" : decision.metadata.activityType;
  if (activityType === undefined) return decision;
  const desired = ACTIVITY_STATE[activityType];
  if (canTransitionAgentState(current, desired)) return decision;
  return {
    action: "IDLE",
    reason: `${decision.reason} (${activityType} cannot start from ${current}; going idle first)`,
    priority: decision.priority,
    metadata: {},
  };
}

/** Maps a decision to an executable action, or null when no action is needed. */
export function decisionToAction(decision: Decision): AgentAction | null {
  switch (decision.action) {
    case "CONTINUE_ACTIVITY":
      return null;
    case "MOVE":
      return decision.metadata.toLocationId === undefined || decision.metadata.toLocationId === null
        ? null
        : { type: "MOVE", toLocationId: decision.metadata.toLocationId, reason: decision.reason };
    case "START_ACTIVITY": {
      const activityType = decision.metadata.activityType;
      if (activityType === undefined) return null;
      return {
        type: "START_ACTIVITY",
        activityType,
        ...(decision.metadata.durationSimMinutes !== undefined
          ? { durationSimMinutes: decision.metadata.durationSimMinutes }
          : {}),
        reason: decision.reason,
      };
    }
    case "REST":
      return {
        type: "REST",
        ...(decision.metadata.durationSimMinutes !== undefined
          ? { durationSimMinutes: decision.metadata.durationSimMinutes }
          : {}),
        reason: decision.reason,
      };
    case "IDLE":
      return { type: "IDLE", reason: decision.reason };
    case "STOP_ACTIVITY":
      return { type: "STOP_ACTIVITY", reason: decision.reason };
    default:
      return null;
  }
}

async function controlWorldSafely(
  db: DbClient,
  action: WorldControlAction,
  actor: ActorRef,
  worldId?: string,
): Promise<World> {
  return controlWorld(db, action, { actor }, worldId);
}

let engineInstance: SimulationEngine | null = null;

/**
 * Process-wide engine. The API wires this at boot; tests construct their own
 * instance with an injected clock for deterministic ticks.
 */
export function getSimulationEngine(options?: SimulationEngineOptions): SimulationEngine {
  if (engineInstance === null) {
    engineInstance = new SimulationEngine(prisma, options);
  }
  return engineInstance;
}

export function setSimulationEngine(engine: SimulationEngine | null): void {
  engineInstance = engine;
}
