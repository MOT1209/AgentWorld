/**
 * Process manager — every spawned child belongs to a workspace.
 *
 * Spawn is argv-based (never a shell string), output is capped, and a
 * timeout kills runaways. Each live process is tagged with the workspace
 * that owns it so cleanup and audit stay possible. Finished processes leave
 * the table immediately; history lives in ToolInvocation rows, not here.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface SpawnOptions {
  workspaceId: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

export interface SpawnResult {
  executionId: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

interface LiveProcess {
  child: ChildProcess;
  workspaceId: string;
  command: string[];
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
}

const KILL_GRACE_MS = 5000;

export class ProcessManager {
  private readonly live = new Map<string, LiveProcess>();
  private counter = 0;

  get liveCount(): number {
    return this.live.size;
  }

  async exec(options: SpawnOptions): Promise<SpawnResult> {
    if (options.command.length === 0) throw new Error("Empty command");
    const startedAt = Date.now();
    const executionId = `tex_${Date.now().toString(36)}_${(this.counter += 1)}`;
    const [binary, ...args] = options.command as [string, ...string[]];

    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // Own process group (POSIX) so a timeout/kill reaches grandchildren too
      // (npm -> node -> ...), not just the direct child.
      detached: process.platform !== "win32",
    });

    return new Promise<SpawnResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const record: LiveProcess = {
        child,
        workspaceId: options.workspaceId,
        command: options.command,
        startedAt,
        timer: setTimeout(() => {
          timedOut = true;
          this.terminate(record, "SIGKILL");
        }, options.timeoutMs),
      };
      // The timeout must never hold the event loop open on its own.
      record.timer.unref?.();
      this.live.set(executionId, record);

      const append = (store: "out" | "err", chunk: Buffer): void => {
        if (truncated) return;
        const text = chunk.toString("utf8");
        if (store === "out") {
          if (stdout.length + text.length > options.maxBytes) {
            stdout += text.slice(0, Math.max(0, options.maxBytes - stdout.length));
            truncated = true;
          } else {
            stdout += text;
          }
        } else if (stderr.length + text.length > options.maxBytes) {
          stderr += text.slice(0, Math.max(0, options.maxBytes - stderr.length));
          truncated = true;
        } else {
          stderr += text;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));
      child.on("error", (error: Error) => {
        if (settled) return;
        settled = true;
        this.forget(executionId, record);
        resolve({
          executionId,
          exitCode: null,
          signal: null,
          stdout,
          stderr: stderr + `\nspawn error: ${error.message}`,
          truncated,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
      child.on("close", (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        this.forget(executionId, record);
        resolve({
          executionId,
          exitCode: code,
          signal,
          stdout,
          stderr,
          truncated,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  /** SIGTERM now, SIGKILL after a grace period. True when it was live. */
  kill(executionId: string): boolean {
    const record = this.live.get(executionId);
    if (record === undefined) return false;
    this.terminate(record, "SIGTERM");
    record.killTimer = setTimeout(() => this.terminate(record, "SIGKILL"), KILL_GRACE_MS);
    record.killTimer.unref?.();
    return true;
  }

  liveInWorkspace(workspaceId: string): string[] {
    const ids: string[] = [];
    for (const [id, record] of this.live) {
      if (record.workspaceId === workspaceId) ids.push(id);
    }
    return ids;
  }

  private terminate(record: LiveProcess, signal: "SIGTERM" | "SIGKILL"): void {
    const pid = record.child.pid;
    try {
      if (process.platform !== "win32" && pid !== undefined) {
        process.kill(-pid, signal);
        return;
      }
    } catch {
      // Group already gone or not signalable; fall back to the direct child.
    }
    try {
      record.child.kill(signal);
    } catch {
      // Already gone; close handler settles the promise.
    }
  }

  private forget(executionId: string, record: LiveProcess): void {
    clearTimeout(record.timer);
    if (record.killTimer !== undefined) clearTimeout(record.killTimer);
    this.live.delete(executionId);
  }
}

/** Process table shared by the terminal tools in one process. */
export const terminalProcesses = new ProcessManager();
