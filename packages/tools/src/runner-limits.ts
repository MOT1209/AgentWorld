/**
 * Limits shared by every command runner backend (kept apart from
 * command-runner.ts so docker-runner.ts can use them without an import cycle).
 */
import { getConfig } from "../../shared/src/index.js";
import type { SpawnResult } from "./process-manager.js";

/** Error result for a command that was refused before anything was spawned. */
export function refusedResult(executionId: string | undefined, reason: string): SpawnResult {
  return {
    executionId: executionId ?? "refused",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: reason,
    truncated: false,
    timedOut: false,
    cancelled: false,
    durationMs: 0,
  };
}

/** Over the process cap? Then the refusal message, else null. */
export function concurrencyRefusal(liveCount: number): string | null {
  const max = getConfig().exec.maxConcurrent;
  return liveCount >= max ? `refused: ${max} agent commands already running (EXEC_MAX_CONCURRENT)` : null;
}
