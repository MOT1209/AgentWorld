/**
 * Command runner seam.
 *
 * Every process an agent starts goes through a `CommandRunner`. Today the only
 * implementation is the host-local `ProcessManager`; the container backend
 * (see the isolation plan, phase 2) plugs in here without touching the tools.
 *
 * Fail closed: with EXEC_SANDBOX=docker a missing daemon/image stops the server
 * at boot and any later docker problem is an error result, never a quiet
 * fallback to running on the host.
 */
import { getConfig, logger } from "../../shared/src/index.js";
import { DockerRunner } from "./docker-runner.js";
import { terminalProcesses, type ProcessManager, type SpawnOptions, type SpawnResult } from "./process-manager.js";

export type { SpawnOptions, SpawnResult };

export interface CommandRunner {
  readonly backend: "local" | "docker";
  exec(options: SpawnOptions): Promise<SpawnResult>;
  /** SIGTERM-then-SIGKILL (or the backend's equivalent). True when it was live. */
  kill(executionId: string): boolean;
  liveInWorkspace(workspaceId: string): string[];
  readonly liveCount: number;
}

const log = logger.child({ component: "tools.command-runner" });
let warnedLocalInProduction = false;

/** Host-local runner: no isolation beyond the command policy. Dev/test only. */
export function localRunner(manager: ProcessManager = terminalProcesses): CommandRunner {
  return {
    backend: "local",
    exec: (options) => manager.exec(options),
    kill: (executionId) => manager.kill(executionId),
    liveInWorkspace: (workspaceId) => manager.liveInWorkspace(workspaceId),
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
  if (getConfig().isProduction && !warnedLocalInProduction) {
    warnedLocalInProduction = true;
    log.warn(
      "Agent commands run on the HOST with no container isolation (EXEC_SANDBOX=local). " +
        "The command policy is defense-in-depth, not a sandbox. Do not enable real AI providers or untrusted agents.",
      { action: "exec.unsandboxed" },
    );
  }
  return local;
}

/** Call at boot: with EXEC_SANDBOX=docker the server refuses to start if Docker or the image is missing. */
export async function verifyCommandRunner(): Promise<void> {
  const runner = getCommandRunner();
  if (runner instanceof DockerRunner) await runner.verify();
}
