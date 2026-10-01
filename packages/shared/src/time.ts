/**
 * Simulation time.
 *
 * Two clocks exist and they must never be confused:
 *
 *   wallClockNow()  -- real time. Used for security (token expiry, rate limits),
 *                     audit ordering, and DB timestamps that must not be
 *                     forgeable by advancing the simulation.
 *   SimulatedClock -- world time. Derived from the World's persisted
 *                     timeOffsetMinutes plus the elapsed real time scaled by
 *                     timeScale. Agents think, rest and age in this clock;
 *                     money and permissions do not.
 *
 * Keeping the two separate is what stops "fast-forward the day" from also
 * fast-forwarding an approval window.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function wallClockNow(): Date {
  return new Date();
}

/** Activity blocks an agent can occupy during a simulated day (Phase 2 hook). */
export const DAILY_PHASES = [
  "MORNING",
  "WORK",
  "BREAK",
  "SHOPPING",
  "SOCIALISING",
  "HOME",
  "SLEEP",
] as const;
export type DailyPhase = (typeof DAILY_PHASES)[number];

export function dailyPhase(at: Date): DailyPhase {
  const hour = at.getHours();
  if (hour >= 5 && hour < 8) return "MORNING";
  if (hour >= 8 && hour < 12) return "WORK";
  if (hour >= 12 && hour < 13) return "BREAK";
  if (hour >= 13 && hour < 17) return "WORK";
  if (hour >= 17 && hour < 20) return "SOCIALISING";
  if (hour >= 20 && hour < 23) return "HOME";
  return "SLEEP";
}

export interface SimulatedTime {
  simulatedNow: Date;
  wallNow: Date;
  offsetMinutes: number;
  timeScale: number;
  phase: DailyPhase;
}

/** Lowest representable speed. 0.5x is a development control, not a limit. */
export const MIN_TIME_SCALE = 0.1;
export const MAX_TIME_SCALE = 10_000;

/** Clamps a world's speed multiplier to the representable range. */
export function clampTimeScale(timeScale: number): number {
  if (!Number.isFinite(timeScale)) return 1;
  return Math.min(MAX_TIME_SCALE, Math.max(MIN_TIME_SCALE, timeScale));
}

/**
 * `simulatedNow = wallNow + offset`, where the offset is the simulation LEAD
 * over the wall clock. This is why the wall timestamp is never multiplied by
 * the speed: `nextOffset` accumulates the lead instead (see below), so
 * simulated time advances at exactly `timeScale` x real time.
 */
export function computeSimulatedTime(
  world: { timeOffsetMinutes: number; timeScale: number },
  at: Date = new Date(),
): SimulatedTime {
  const effectiveScale = clampTimeScale(world.timeScale);
  const simulatedNow = new Date(at.getTime() + world.timeOffsetMinutes * MINUTE_MS);
  return {
    simulatedNow,
    wallNow: at,
    offsetMinutes: world.timeOffsetMinutes,
    timeScale: effectiveScale,
    phase: dailyPhase(simulatedNow),
  };
}

/**
 * Advances the persisted lead by `elapsedRealMinutes x (timeScale - 1)`.
 *
 * Because the lead is added to the wall clock, the resulting rate is
 * `1 + (timeScale - 1) = timeScale` -- exactly the configured speed. Storing
 * the lead (rather than recomputing from a fixed epoch) makes a tick
 * idempotent: two heartbeats cannot double-apply the same interval.
 *
 * A paused world does not accumulate lead because the engine stops ticking it.
 */
export function nextOffset(
  world: { timeOffsetMinutes: number; lastTickAt: Date | null },
  timeScale: number,
  at: Date = new Date(),
): number {
  if (world.lastTickAt === null) return world.timeOffsetMinutes;
  const elapsedMs = Math.max(0, at.getTime() - world.lastTickAt.getTime());
  const scale = clampTimeScale(timeScale);
  const leadMs = elapsedMs * (scale - 1);
  // Kept fractional: at 0.5x a sub-minute tick must not be truncated to zero
  // or the world would never appear to move.
  return world.timeOffsetMinutes + leadMs / MINUTE_MS;
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}
