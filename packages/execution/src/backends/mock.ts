/**
 * Mock backend — deterministic and offline. Replays a queue of scripted
 * outcomes (FIFO) and records every request so tests can assert what the
 * runner actually asked for. With an empty queue every run succeeds.
 */
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../backend.js";

export interface MockOutcome {
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  timedOut?: boolean;
  durationMs?: number;
}

export class MockExecutionBackend implements ExecutionBackend {
  readonly id = "mock" as const;
  readonly calls: ExecutionRequest[] = [];
  private readonly queue: MockOutcome[];

  constructor(outcomes: MockOutcome[] = []) {
    this.queue = [...outcomes];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    this.calls.push(request);
    const outcome = this.queue.shift() ?? {};
    return {
      backendId: "mock",
      exitCode: outcome.exitCode ?? 0,
      signal: outcome.signal ?? null,
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
      truncated: outcome.truncated ?? false,
      timedOut: outcome.timedOut ?? false,
      durationMs: outcome.durationMs ?? 1,
    };
  }
}
