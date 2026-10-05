/**
 * Process manager — every spawned child belongs to a workspace.
 *
 * Spawn is argv-based (never a shell string), output is capped, and a
 * timeout kills runaways. Each live process is tagged with the workspace
 * that owns it so cleanup and audit stay possible. Finished processes leave
 * the table immediately; history lives in ToolInvocation rows, not here.
 */
import { spawn, type ChildProcess } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

export interface SpawnOptions {
  workspaceId: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  /** Aborting kills the whole process tree and marks the result `cancelled`. */
  signal?: AbortSignal;
}

export interface SpawnResult {
  executionId: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
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
      // POSIX: own process group so the whole tree can be signalled at once.
      detached: !IS_WINDOWS,
    });

    return new Promise<SpawnResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let cancelled = false;
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

      const onAbort = (): void => {
        cancelled = true;
        this.terminate(record, "SIGKILL");
      };
      if (options.signal !== undefined) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

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
          cancelled,
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
          cancelled,
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

  /** Snapshot of one live process, or null once it has finished. */
  status(executionId: string): { executionId: string; workspaceId: string; command: string[]; runningMs: number } | null {
    const record = this.live.get(executionId);
    if (record === undefined) return null;
    return {
      executionId,
      workspaceId: record.workspaceId,
      command: record.command,
      runningMs: Date.now() - record.startedAt,
    };
  }

  liveInWorkspace(workspaceId: string): string[] {
    const ids: string[] = [];
    for (const [id, record] of this.live) {
      if (record.workspaceId === workspaceId) ids.push(id);
    }
    return ids;
  }

  /**
   * Kills the process AND its children. `npm test` is a wrapper around the
   * real worker; killing only the wrapper would leave orphans running.
   */
  private terminate(record: LiveProcess, signal: "SIGTERM" | "SIGKILL"): void {
    const pid = record.child.pid;
    try {
      if (pid !== undefined && IS_WINDOWS) {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false })
          .on("error", () => record.child.kill(signal))
          .unref();
      } else if (pid !== undefined) {
        process.kill(-pid, signal);
      } else {
        record.child.kill(signal);
      }
    } catch {
      try {
        record.child.kill(signal);
      } catch {
        // Already gone; close handler settles the promise.
      }
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
