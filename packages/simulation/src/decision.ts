/**
 * Deterministic decision engine.
 *
 * Phase 1 deliberately does NOT ask a language model what an agent should do.
 * Every tick must be cheap and reproducible, and an offline system must still
 * behave sensibly. So decisions are RULES over the agent's state, needs, the
 * simulated day phase and its location.
 *
 * The interface is the extension point: a future `LlmDecisionEngine` implements
 * the same `DecisionEngine` and is swapped in by configuration. Rules here are
 * the fallback that always works, including with no AI provider configured.
 */
import type { ActivityType, AgentState, DailyPhase, NeedType } from "../../shared/src/index.js";
import { NEED_THRESHOLDS } from "./needs.js";

export type DecisionAction =
  | "CONTINUE_ACTIVITY"
  | "MOVE"
  | "START_ACTIVITY"
  | "STOP_ACTIVITY"
  | "REST"
  | "IDLE";

export interface Decision {
  action: DecisionAction;
  /** Human-readable why. Surfaced in the UI and stored on the activity. */
  reason: string;
  /** 0..100, higher is more urgent. */
  priority: number;
  metadata: {
    activityType?: ActivityType;
    toLocationId?: string | null;
    durationSimMinutes?: number;
  };
}

export interface DecisionContext {
  agentId: string;
  state: AgentState;
  needs: Record<NeedType, number>;
  phase: DailyPhase;
  hasOpenActivity: boolean;
  currentLocationId: string | null;
  /** Where this agent normally works (its role's location), if known. */
  workLocationId?: string | null;
  /** A shared/canteen location used for socialising, if known. */
  commonLocationId?: string | null;
}

export interface DecisionEngine {
  readonly id: string;
  decide(context: DecisionContext): Decision;
}

/** Default activity durations, in SIMULATED minutes. */
export const DEFAULT_DURATIONS = {
  REST: 60,
  SLEEP: 420,
  WORK: 120,
  SOCIALIZE: 60,
  THINK: 45,
  TRAVEL: 15,
  IDLE: 30,
} as const;

export class DeterministicDecisionEngine implements DecisionEngine {
  readonly id = "deterministic-rules-v1";

  decide(context: DecisionContext): Decision {
    const { needs, phase, state, hasOpenActivity } = context;

    // 1. An open activity always wins: the agent finishes what it started.
    if (hasOpenActivity) {
      return {
        action: "CONTINUE_ACTIVITY",
        reason: "An activity is already in progress; continue it.",
        priority: 100,
        metadata: {},
      };
    }

    // 2. A sleeping agent wakes once rested enough.
    if (state === "SLEEPING" && needs.ENERGY >= 90) {
      return {
        action: "IDLE",
        reason: "Rested enough to wake.",
        priority: 40,
        metadata: { durationSimMinutes: DEFAULT_DURATIONS.IDLE },
      };
    }

    // 3. Energy is the hard constraint: below critical, rest immediately.
    if (needs.ENERGY <= NEED_THRESHOLDS.CRITICAL) {
      return {
        action: "REST",
        reason: `Energy critical (${Math.round(needs.ENERGY)}); resting.`,
        priority: 95,
        metadata: { activityType: "REST", durationSimMinutes: DEFAULT_DURATIONS.REST },
      };
    }

    // 4. Hunger is a reserve. Eating is a Phase 2 activity, so Phase 1 models
    //    recovery through rest and records the reason explicitly.
    if (needs.HUNGER <= NEED_THRESHOLDS.CRITICAL) {
      return {
        action: "REST",
        reason: `Hunger low (${Math.round(needs.HUNGER)}); taking a restorative break (eating arrives in Phase 2).`,
        priority: 75,
        metadata: { activityType: "REST", durationSimMinutes: DEFAULT_DURATIONS.REST },
      };
    }

    // 5. Night: sleep.
    if (phase === "SLEEP" && needs.ENERGY < NEED_THRESHOLDS.LOW_ENERGY_FOR_SLEEP) {
      return {
        action: "START_ACTIVITY",
        reason: "Night in the simulated day; sleeping.",
        priority: 85,
        metadata: { activityType: "SLEEP", durationSimMinutes: DEFAULT_DURATIONS.SLEEP },
      };
    }

    // 6. Social battery low: go to the common area and socialise.
    if (needs.SOCIAL <= NEED_THRESHOLDS.LOW) {
      const target = context.commonLocationId ?? null;
      if (target !== null && target !== context.currentLocationId) {
        return {
          action: "MOVE",
          reason: `Social need low (${Math.round(needs.SOCIAL)}); heading to the common area.`,
          priority: 70,
          metadata: { toLocationId: target },
        };
      }
      return {
        action: "START_ACTIVITY",
        reason: `Social need low (${Math.round(needs.SOCIAL)}); socialising.`,
        priority: 70,
        metadata: { activityType: "SOCIALIZE", durationSimMinutes: DEFAULT_DURATIONS.SOCIALIZE },
      };
    }

    // 7. Working hours: work. Moving to the work location is a separate step
    //    the engine performs first so the movement is visible.
    if (phase === "WORK" || phase === "MORNING") {
      const target = context.workLocationId ?? null;
      if (target !== null && target !== context.currentLocationId) {
        return {
          action: "MOVE",
          reason: "Working hours in the simulated day; heading to the work location.",
          priority: 60,
          metadata: { toLocationId: target },
        };
      }
      return {
        action: "START_ACTIVITY",
        reason: "Working hours in the simulated day; working.",
        priority: 60,
        metadata: { activityType: "WORK", durationSimMinutes: DEFAULT_DURATIONS.WORK },
      };
    }

    // 8. Entertainment below target: idle recreation.
    if (needs.ENTERTAINMENT <= NEED_THRESHOLDS.LOW) {
      return {
        action: "IDLE",
        reason: `Entertainment low (${Math.round(needs.ENTERTAINMENT)}); taking idle time.`,
        priority: 35,
        metadata: { durationSimMinutes: DEFAULT_DURATIONS.IDLE },
      };
    }

    // 9. Nothing pressing.
    return {
      action: "IDLE",
      reason: "No pressing need; idling.",
      priority: 10,
      metadata: { durationSimMinutes: DEFAULT_DURATIONS.IDLE },
    };
  }
}

export const decisionEngine = new DeterministicDecisionEngine();
