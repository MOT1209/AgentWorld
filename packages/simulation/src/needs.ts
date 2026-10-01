/**
 * Simulated needs.
 *
 * Stored in the existing `AgentState.vitals` JSON column (no new table).
 * Convention: for EVERY need, a HIGHER value is better ("more satisfied").
 * So `HUNGER` means satiety, not appetite -- eating is a Phase 2 activity, and
 * until it exists rest/sleep model recovery.
 *
 * Values are 0..100. Deltas are expressed per SIMULATED MINUTE, which makes
 * them independent of both the tick interval and the world speed: a world at
 * 60x simply applies sixty times as many simulated minutes per real minute.
 *
 * These are deterministic gameplay numbers. They are not a model of human
 * biology and must never be described as one.
 */
import { z } from "zod";
import { NEED_TYPES, type ActivityType, type NeedType } from "../../shared/src/index.js";

export const NEED_MIN = 0;
export const NEED_MAX = 100;

/** Starting values for a freshly-activated agent. */
export const INITIAL_NEEDS: Record<NeedType, number> = {
  ENERGY: 85,
  HUNGER: 75,
  SOCIAL: 65,
  REST: 80,
  ENTERTAINMENT: 60,
};

/**
 * Per-simulated-minute deltas by activity. Ordinary room for every activity's
 * duration: WORK costs energy over an eight-hour block (480 x 0.12 = 58),
 * SLEEP restores it (420 x 0.45 = 189, clamped at 100).
 */
export const NEED_DELTAS: Record<ActivityType, Record<NeedType, number>> = {
  WORK: { ENERGY: -0.12, HUNGER: -0.06, SOCIAL: -0.04, REST: -0.06, ENTERTAINMENT: -0.03 },
  THINK: { ENERGY: -0.06, HUNGER: -0.05, SOCIAL: -0.02, REST: -0.03, ENTERTAINMENT: 0.02 },
  TRAVEL: { ENERGY: -0.09, HUNGER: -0.06, SOCIAL: -0.02, REST: -0.05, ENTERTAINMENT: 0.03 },
  SOCIALIZE: { ENERGY: -0.05, HUNGER: -0.04, SOCIAL: 0.3, REST: -0.02, ENTERTAINMENT: 0.25 },
  REST: { ENERGY: 0.35, HUNGER: 0.04, SOCIAL: -0.02, REST: 0.3, ENTERTAINMENT: 0.1 },
  SLEEP: { ENERGY: 0.45, HUNGER: 0.05, SOCIAL: -0.02, REST: 0.4, ENTERTAINMENT: 0.05 },
  IDLE: { ENERGY: 0.05, HUNGER: -0.03, SOCIAL: -0.02, REST: 0.08, ENTERTAINMENT: 0.08 },
};

/** Thresholds at which the decision engine reacts. */
export const NEED_THRESHOLDS = {
  CRITICAL: 20,
  LOW: 25,
  LOW_ENERGY_FOR_SLEEP: 60,
} as const;

/** Below this, a need is "unsatisfied" and worth reacting to. */
export const CRITICAL_NEED_LEVEL = NEED_THRESHOLDS.CRITICAL;

/**
 * Explicit object rather than `z.record(enum, ...)`: a record keyed by an enum
 * infers as Partial, and a need set is never partial -- every need always has a
 * value. The explicit shape keeps that guarantee in the type system.
 */
export const NeedsSchema = z.object({
  ENERGY: z.number().min(NEED_MIN).max(NEED_MAX),
  HUNGER: z.number().min(NEED_MIN).max(NEED_MAX),
  SOCIAL: z.number().min(NEED_MIN).max(NEED_MAX),
  REST: z.number().min(NEED_MIN).max(NEED_MAX),
  ENTERTAINMENT: z.number().min(NEED_MIN).max(NEED_MAX),
});

export const VitalsSchema = z.object({
  needs: NeedsSchema,
  updatedAt: z.string().optional(),
});

export type Vitals = z.infer<typeof VitalsSchema>;

export function clampNeed(value: number): number {
  if (!Number.isFinite(value)) return NEED_MIN;
  return Math.min(NEED_MAX, Math.max(NEED_MIN, value));
}

export function needsFromInitial(overrides: Partial<Record<NeedType, number>> = {}): Record<NeedType, number> {
  const needs = { ...INITIAL_NEEDS };
  for (const key of NEED_TYPES) {
    const override = overrides[key];
    if (override !== undefined) needs[key] = clampNeed(override);
  }
  return needs;
}

/** Parses the vitals column, defaulting to a fresh agent's starting needs. */
export function parseVitals(raw: string | null | undefined): Vitals {
  if (raw === null || raw === undefined || raw.trim() === "" || raw.trim() === "{}") {
    return { needs: { ...INITIAL_NEEDS } };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch {
    return { needs: { ...INITIAL_NEEDS } };
  }
  if (candidate === null || typeof candidate !== "object") {
    return { needs: { ...INITIAL_NEEDS } };
  }
  const object = candidate as Record<string, unknown>;
  const rawNeeds = (object.needs ?? object) as Record<string, unknown>;
  const needs = { ...INITIAL_NEEDS };
  for (const key of NEED_TYPES) {
    const value = rawNeeds[key];
    if (typeof value === "number") needs[key] = clampNeed(value);
  }
  const updatedAt = typeof object.updatedAt === "string" ? object.updatedAt : undefined;
  return { needs, ...(updatedAt !== undefined ? { updatedAt } : {}) };
}

export function serializeVitals(vitals: Vitals): string {
  return JSON.stringify(vitals);
}

/**
 * Applies `simulatedMinutes` of the given activity to a need set.
 *
 * Pure and deterministic. Returns the need types whose value actually changed
 * so the engine can skip a database write when nothing moved (for example a
 * very fast tick on an IDLE agent whose needs are already at their bounds).
 */
export function applyNeedsTick(
  vitals: Vitals,
  activity: ActivityType | null,
  simulatedMinutes: number,
): { needs: Record<NeedType, number>; changed: NeedType[] } {
  const minutes = Math.max(0, simulatedMinutes);
  const table = NEED_DELTAS[activity ?? "IDLE"];
  const needs = { ...vitals.needs };
  const changed: NeedType[] = [];

  for (const key of NEED_TYPES) {
    const before = needs[key];
    const after = clampNeed(before + table[key] * minutes);
    if (after !== before) {
      needs[key] = after;
      changed.push(key);
    }
  }

  return { needs, changed };
}

/** Need types at or below the critical threshold, most urgent first. */
export function criticalNeeds(needs: Record<NeedType, number>): NeedType[] {
  return NEED_TYPES.filter((key) => needs[key] <= CRITICAL_NEED_LEVEL).sort(
    (a, b) => needs[a] - needs[b],
  );
}
