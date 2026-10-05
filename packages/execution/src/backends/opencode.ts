/**
 * OpenCode execution backend.
 *
 * THE only source file allowed to know how the OpenCode CLI is invoked;
 * the executable name comes from `OPENCODE_COMMAND` in config (the other
 * sanctioned location). AgentWorld owns permissions, workspace binding,
 * lifecycle and audit; this file only builds argv and runs a process.
 *
 * Deliberately NEVER passes `--auto` (auto-approve) or interactive flags:
 * a headless run must not silently grant permissions server-side. The
 * prompt is placed after `--` so it can never be parsed as a flag.
 */
import { getConfig } from "../../../shared/src/config.js";
import { filterEnv } from "../../../tools/src/command-policy.js";
import { ProcessManager } from "../../../tools/src/process-manager.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../backend.js";

/** Pure argv builder, exported for tests. Prompt always trails `--`. */
export function buildOpenCodeArgv(command: string, prompt: string): string[] {
  return [command, "run", "--format", "json", "--", prompt];
}

export class OpenCodeExecutionBackend implements ExecutionBackend {
  readonly id = "opencode" as const;
  private readonly manager = new ProcessManager();
  private readonly command: string;

  constructor(command?: string) {
    this.command = command ?? getConfig().execution.openCodeCommand;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const probe = await this.manager.exec({
        workspaceId: "",
        command: [this.command, "--version"],
        cwd: process.cwd(),
        env: filterEnv(),
        timeoutMs: 10_000,
        maxBytes: 1024,
      });
      return probe.exitCode === 0;
    } catch {
      return false;
    }
  }

  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const prompt = (request.prompt ?? "").trim();
    if (prompt === "") {
      throw new Error("OpenCode backend requires a non-empty prompt");
    }
    // OpenCode needs the network and the operator's model credentials, so it
    // can only run on the host. With the Docker sandbox on, that would be a
    // silent hole in the isolation: refuse instead (fail closed).
    if (getConfig().exec.sandbox === "docker") {
      throw new Error("The OpenCode backend runs on the host and is disabled while EXEC_SANDBOX=docker");
    }
    const argv = buildOpenCodeArgv(this.command, prompt);
    const result = await this.manager.exec({
      workspaceId: request.workspaceId ?? "",
      command: argv,
      cwd: request.cwd,
      env: filterEnv(request.env),
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxBytes,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    return {
      backendId: "opencode",
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
