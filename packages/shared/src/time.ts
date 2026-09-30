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

export function computeSimulatedTime(
  world: { timeOffsetMinutes: number; timeScale: number },
  at: Date = new Date(),
): SimulatedTime {
  const effectiveScale = Math.max(1, world.timeScale);
  const scaled = new Date(at.getTime() * effectiveScale);
  const simulatedNow = new Date(scaled.getTime() + world.timeOffsetMinutes * MINUTE_MS);
  return {
    simulatedNow,
    wallNow: at,
    offsetMinutes: world.timeOffsetMinutes,
    timeScale: effectiveScale,
    phase: dailyPhase(simulatedNow),
  };
}

/**
 * Advances the persisted offset by the elapsed real time x timeScale.
 * Called by the world heartbeat; the result is idempotent per tick because the
 * offset is stored, not recomputed from a fixed epoch.
 */
export function nextOffset(
  world: { timeOffsetMinutes: number; lastTickAt: Date | null },
  timeScale: number,
  at: Date = new Date(),
): number {
  if (world.lastTickAt === null) return world.timeOffsetMinutes;
  const elapsedMs = Math.max(0, at.getTime() - world.lastTickAt.getTime());
  const elapsedScaledMs = elapsedMs * Math.max(1, timeScale);
  return world.timeOffsetMinutes + Math.floor(elapsedScaledMs / MINUTE_MS);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}
