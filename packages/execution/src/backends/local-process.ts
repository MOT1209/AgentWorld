/**
 * Local process backend — runs the job's argv directly through the shared
 * ProcessManager: no shell, capped output, hard timeout, kill grace. The
 * runner guarantees `cwd` is a real directory before calling `run`.
 */
import { ProcessManager } from "../../../tools/src/process-manager.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../backend.js";

export class LocalProcessBackend implements ExecutionBackend {
  readonly id = "local" as const;
  private readonly manager = new ProcessManager();

  async isAvailable(): Promise<boolean> {
    // The backend runs argv under the same Node runtime that runs the API.
    return true;
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const argv = request.argv;
    if (argv === undefined || argv.length === 0) {
      return {
        backendId: "local",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "Local backend requires an argv array.",
        truncated: false,
        timedOut: false,
        durationMs: 0,
      };
    }
    const result = await this.manager.exec({
      workspaceId: request.workspaceId ?? "",
      command: argv,
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxBytes,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    return {
      backendId: "local",
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
    };
  }
}
