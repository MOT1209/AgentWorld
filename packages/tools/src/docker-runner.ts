/**
 * Container backend for agent commands.
 *
 * One throwaway container per command. The container is the security
 * boundary; the command policy above it only reduces approval noise.
 *
 *  - no network, read-only root filesystem, all capabilities dropped,
 *    no-new-privileges, pids/memory/cpu limits, never root
 *  - ONLY the workspace directory is mounted (read-write at /work); the host
 *    filesystem, the Docker socket and the server's environment are absent
 *  - fail closed: any problem running docker is an error result, never a
 *    fallback to running the command on the host
 */
import { execFile, type ExecFileException } from "node:child_process";
import { statSync } from "node:fs";
import { ProcessManager, type SpawnOptions, type SpawnResult } from "./process-manager.js";
import type { CommandRunner } from "./command-runner.js";

export interface DockerRunnerSettings {
  image: string;
  /** "uid:gid". Empty = owner of the workspace directory (refused if root). */
  user: string;
  memory: string;
  cpus: string;
  pids: number;
}

const KILL_GRACE_MS = 5_000;
const TIMEOUT_BACKSTOP_MS = 15_000;
/** Host-specific variables that are meaningless (or harmful) inside the container. */
const HOST_ONLY_ENV = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USER", "LANG", "LC_ALL"]);
const CLI_ENV_KEYS = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "SystemRoot"];

function dockerCliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CLI_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function dockerCli(args: string[], timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("docker", args, { env: dockerCliEnv(), timeout: timeoutMs, windowsHide: true }, (error: ExecFileException | null, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
        stdout: String(stdout),
        stderr: String(stderr) + (error !== null && typeof error.code !== "number" ? `\n${error.message}` : ""),
      });
    });
  });
}

export class DockerRunner implements CommandRunner {
  readonly backend = "docker" as const;
  private readonly manager = new ProcessManager();
  private counter = 0;

  constructor(private readonly settings: DockerRunnerSettings) {}

  get liveCount(): number {
    return this.manager.liveCount;
  }

  liveInWorkspace(workspaceId: string): string[] {
    return this.manager.liveInWorkspace(workspaceId);
  }

  /** Startup check: the daemon answers and the sandbox image exists locally. */
  async verify(): Promise<void> {
    const version = await dockerCli(["version", "--format", "{{.Server.Version}}"]);
    if (version.code !== 0) {
      throw new Error(`EXEC_SANDBOX=docker but the Docker daemon is not reachable: ${version.stderr.trim().slice(0, 300)}`);
    }
    const image = await dockerCli(["image", "inspect", "--format", "{{.Id}}", this.settings.image]);
    if (image.code !== 0) {
      throw new Error(
        `EXEC_SANDBOX=docker but image '${this.settings.image}' is not present. Build it: docker build -t ${this.settings.image} docker/sandbox`,
      );
    }
  }

  private resolveUser(cwd: string): string {
    if (this.settings.user !== "") return this.settings.user;
    const stat = statSync(cwd);
    if (stat.uid === 0) {
      throw new Error(
        "Workspace directory is owned by root; refusing to run the container as root. " +
          "Run the server as a non-root user or set EXEC_DOCKER_USER=uid:gid.",
      );
    }
    return `${stat.uid}:${stat.gid}`;
  }

  buildArgs(name: string, options: SpawnOptions): string[] {
    if (options.cwd.includes(",") || options.cwd.includes("\n")) {
      throw new Error("Workspace path contains characters that cannot be mounted safely");
    }
    const user = this.resolveUser(options.cwd);
    const args = [
      "run", "--rm", "--init",
      `--name=${name}`,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--user=${user}`,
      `--pids-limit=${this.settings.pids}`,
      `--memory=${this.settings.memory}`,
      `--memory-swap=${this.settings.memory}`,
      `--cpus=${this.settings.cpus}`,
      "--tmpfs=/tmp:rw,nosuid,size=64m",
      `--mount=type=bind,source=${options.cwd},target=/work`,
      "--workdir=/work",
      "-e", "HOME=/tmp",
      // git refuses a repo owned by another uid; /work is the one repo here.
      "-e", "GIT_CONFIG_COUNT=1",
      "-e", "GIT_CONFIG_KEY_0=safe.directory",
      "-e", "GIT_CONFIG_VALUE_0=/work",
    ];
    for (const [key, value] of Object.entries(options.env)) {
      if (HOST_ONLY_ENV.has(key.toUpperCase())) continue;
      args.push("-e", `${key}=${value}`);
    }
    args.push(this.settings.image, ...options.command);
    return args;
  }

  async exec(options: SpawnOptions): Promise<SpawnResult> {
    const executionId = options.executionId ?? `tex_${Date.now().toString(36)}_${(this.counter += 1)}`;
    const name = `kw-${executionId}`;
    const started = Date.now();
    let args: string[];
    try {
      args = this.buildArgs(name, options);
    } catch (error) {
      return {
        executionId,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: `sandbox error: ${error instanceof Error ? error.message : String(error)}`,
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started,
      };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void dockerCli(["kill", name]);
    }, options.timeoutMs);
    timer.unref?.();

    const result = await this.manager.exec({
      ...options,
      executionId,
      command: ["docker", ...args],
      cwd: process.cwd(),
      env: dockerCliEnv(),
      // Backstop only: killing the CLI would not stop the container, so the
      // real timeout is the `docker kill` above.
      timeoutMs: options.timeoutMs + TIMEOUT_BACKSTOP_MS,
    });
    clearTimeout(timer);

    if (result.exitCode === null) {
      // The CLI died abnormally; make sure no container outlives it.
      await dockerCli(["rm", "-f", name]);
    }
    return { ...result, timedOut: timedOut || result.timedOut };
  }

  kill(executionId: string): boolean {
    if (!this.manager.has(executionId)) return false;
    const name = `kw-${executionId}`;
    void dockerCli(["kill", "--signal=TERM", name]);
    const hard = setTimeout(() => void dockerCli(["kill", name]), KILL_GRACE_MS);
    hard.unref?.();
    return true;
  }
}
