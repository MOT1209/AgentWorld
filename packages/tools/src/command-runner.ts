/**
 * Command runner seam.
 *
 * Every process an agent starts goes through a `CommandRunner`. Today the only
 * implementation is the host-local `ProcessManager`; the container backend
 * (see the isolation plan, phase 2) plugs in here without touching the tools.
 *
 * Fail closed: with EXEC_SANDBOX=docker a missing daemon/image stops the server
 * at boot and any later docker problem is an error result, never a quiet
 * fallback to running on the host. In production the host-local runner is
 * refused outright unless EXEC_ALLOW_UNSANDBOXED_PRODUCTION=true (config load
 * already refuses to boot; `getCommandRunner` re-checks so no code path can
 * obtain it silently).
 *
 * Both backends: secret-named variables are stripped from the child env
 * here, whoever built it, and at most EXEC_MAX_CONCURRENT agent processes
 * run at once; over the cap a command is refused with an error result.
 */
import { getConfig, logger } from "../../shared/src/index.js";
import { stripSecretEnv } from "./command-policy.js";
import { DockerRunner } from "./docker-runner.js";
import { concurrencyRefusal, refusedResult } from "./runner-limits.js";
import { terminalProcesses, type ProcessManager, type SpawnOptions, type SpawnResult } from "./process-manager.js";

export type { SpawnOptions, SpawnResult };

export interface CommandRunner {
  readonly backend: "local" | "docker";
  exec(options: SpawnOptions): Promise<SpawnResult>;
  /** SIGTERM-then-SIGKILL (or the backend's equivalent). True when it was live. */
  kill(executionId: string): boolean;
  liveInWorkspace(workspaceId: string): string[];
  /** Workspace that owns a live execution (for authorization), or null. */
  workspaceOf(executionId: string): string | null;
  readonly liveCount: number;
}

const log = logger.child({ component: "tools.command-runner" });
let warnedLocalInProduction = false;

/** Host-local runner: no isolation beyond the command policy. Dev/test only. */
export function localRunner(manager: ProcessManager = terminalProcesses): CommandRunner {
  return {
    backend: "local",
    exec: (options) => {
      const refusal = concurrencyRefusal(manager.liveCount);
      if (refusal !== null) return Promise.resolve(refusedResult(options.executionId, refusal));
      return manager.exec({ ...options, env: stripSecretEnv(options.env) });
    },
    kill: (executionId) => manager.kill(executionId),
    liveInWorkspace: (workspaceId) => manager.liveInWorkspace(workspaceId),
    workspaceOf: (executionId) => manager.workspaceOf(executionId),
    get liveCount() {
      return manager.liveCount;
    },
  };
}

const local = localRunner();

let docker: DockerRunner | null = null;

export function getCommandRunner(): CommandRunner {
  const { sandbox, docker: settings } = getConfig().exec;
  if (sandbox === "docker") {
    docker ??= new DockerRunner(settings);
    return docker;
  }
  const config = getConfig();
  if (config.isProduction) {
    if (!config.exec.allowUnsandboxedInProduction) {
      throw new Error(
        "Refusing to run agent commands on the host in production (EXEC_SANDBOX=local without EXEC_ALLOW_UNSANDBOXED_PRODUCTION=true).",
      );
    }
    if (!warnedLocalInProduction) {
      warnedLocalInProduction = true;
      log.warn(
        "Agent commands run on the HOST with no container isolation (EXEC_SANDBOX=local, explicitly allowed by " +
          "EXEC_ALLOW_UNSANDBOXED_PRODUCTION). The command policy is defense-in-depth, not a sandbox. " +
          "Do not enable real AI providers or untrusted agents.",
        { action: "exec.unsandboxed" },
      );
    }
  }
  return local;
}

/** Call at boot: with EXEC_SANDBOX=docker the server refuses to start if Docker or the image is missing. */
export async function verifyCommandRunner(): Promise<void> {
  const runner = getCommandRunner();
  if (runner instanceof DockerRunner) await runner.verify();
}
