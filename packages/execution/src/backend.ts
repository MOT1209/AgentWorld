/**
 * ExecutionBackend — one interface behind every way a job can run.
 *
 * AgentWorld owns permissions, workspace binding, lifecycle and audit; the
 * backend only runs a process and returns a structured `ExecutionResult`.
 * Three implementations exist:
 *
 *   - `mock`   deterministic, offline, always available (CI and tests).
 *   - `local`  spawns the job's argv directly (shell-free, capped, timed).
 *   - `opencode` runs a prompt through the OpenCode CLI. The binary is
 *     named ONLY in `backends/opencode.ts` + the `OPENCODE_COMMAND` config
 *     entry — never anywhere else.
 */
import { getConfig } from "../../shared/src/config.js";
import { LocalProcessBackend } from "./backends/local-process.js";
import { MockExecutionBackend } from "./backends/mock.js";
import { OpenCodeExecutionBackend } from "./backends/opencode.js";

export type ExecutionBackendId = "mock" | "local" | "opencode";

export type ExecutionKind = "COMMAND" | "VERIFY" | "BACKEND";

export interface ExecutionRequest {
  jobId: string;
  kind: ExecutionKind;
  workspaceId: string | null;
  /**
   * Absolute working directory. The runner guarantees a real directory for
   * every backend except `mock`; backends never invent one.
   */
  cwd: string;
  /** argv for COMMAND/VERIFY jobs. Never a concatenated shell line. */
  argv?: string[];
  /** Prompt for BACKEND jobs (the opencode backend). */
  prompt?: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  /** Aborted by the runner when a RUNNING job is cancelled. */
  signal?: AbortSignal;
}

export interface ExecutionResult {
  backendId: ExecutionBackendId;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** True when the run was aborted through the request's AbortSignal. */
  cancelled?: boolean;
  durationMs: number;
}

export interface ExecutionBackend {
  readonly id: ExecutionBackendId;
  /** Cheap probe used by health/smoke paths; never throws. */
  isAvailable(): Promise<boolean>;
  run(request: ExecutionRequest): Promise<ExecutionResult>;
}

export function createBackend(id: ExecutionBackendId | string): ExecutionBackend {
  switch (id) {
    case "mock":
      return new MockExecutionBackend();
    case "local":
      return new LocalProcessBackend();
    case "opencode":
      return new OpenCodeExecutionBackend();
    default:
      throw new Error(`Unknown execution backend '${id}'`);
  }
}

/** The configured default for jobs that do not pin a `backendId`. */
export function defaultBackendId(): ExecutionBackendId {
  return getConfig().execution.defaultBackend;
}
