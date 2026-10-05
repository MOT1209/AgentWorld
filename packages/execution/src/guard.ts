/**
 * Execution guard — the server-side gate in front of every ExecutionJob.
 *
 * `enqueueExecution` is the single creation path (REST, tools, verification),
 * so the gate lives here rather than in each caller:
 *
 *   - a job bound to a workspace must target a usable workspace;
 *   - its working directory must resolve INSIDE that workspace (path guard,
 *     realpath included) — it is never taken from the caller verbatim;
 *   - argv commands pass CommandPolicy: DENY is refused always, and
 *     REQUIRE_APPROVAL is refused unless the caller already cleared it
 *     (the tool executor does, via the approval flow);
 *   - non-mock backends need a workspace: no ambient working directory.
 *
 * The runner re-applies `assertRunnable` right before spawning, so a row
 * written by any other path still cannot run a denied command.
 */
import type { DbClient } from "../../database/src/index.js";
import type { Workspace } from "../../database/src/types.js";
import { forbidden, validationError } from "../../shared/src/index.js";
import { evaluateCommand, type WorkspacePolicyOverride } from "../../tools/src/command-policy.js";
import { resolveInRoot } from "../../workspace/src/index.js";
import { isAbsolute, relative, resolve } from "node:path";

const USABLE_WORKSPACE_STATUSES = new Set(["READY", "BUSY"]);

export function workspacePolicyOverride(workspace: Pick<Workspace, "environment">): WorkspacePolicyOverride | undefined {
  try {
    const env = JSON.parse(workspace.environment) as { policy?: WorkspacePolicyOverride };
    return env.policy;
  } catch {
    return undefined;
  }
}

/** Absolute inputs must already sit inside the root; relative ones resolve under it. */
function contained(root: string, dir: string): string {
  if (!isAbsolute(dir)) return resolveInRoot(root, dir);
  const rel = relative(resolve(root), resolve(dir));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw validationError("Working directory is outside the workspace", { workingDir: dir });
  }
  return resolveInRoot(root, rel);
}

export interface GuardInput {
  kind: "COMMAND" | "VERIFY" | "BACKEND";
  argv?: string[] | undefined;
  backendId?: string | null | undefined;
  workspaceId?: string | null | undefined;
  workingDir?: string | null | undefined;
}

export interface GuardOptions {
  /** True when the approval flow (or a trusted system path) already cleared REQUIRE_APPROVAL. */
  policyCleared?: boolean;
}

export interface GuardResult {
  workspace: Workspace | null;
  /** Absolute, validated working directory (null only for workspace-less mock jobs). */
  cwd: string | null;
}

export async function assertExecutionAllowed(
  db: DbClient,
  input: GuardInput,
  options: GuardOptions = {},
): Promise<GuardResult> {
  let workspace: Workspace | null = null;
  if (input.workspaceId !== null && input.workspaceId !== undefined) {
    workspace = await db.workspace.findUnique({ where: { id: input.workspaceId } });
    if (workspace === null) throw validationError("Workspace not found", { workspaceId: input.workspaceId });
    if (!USABLE_WORKSPACE_STATUSES.has(workspace.status)) {
      throw validationError(`Workspace is ${workspace.status} and cannot run executions`, {
        workspaceId: workspace.id,
      });
    }
  }

  const backend = input.backendId ?? null;
  if (workspace === null) {
    if (backend !== "mock") {
      throw validationError("Executions on this backend require a workspace");
    }
    if (input.workingDir !== null && input.workingDir !== undefined) {
      throw validationError("A working directory requires a workspace");
    }
  }

  let cwd: string | null = null;
  if (workspace !== null) {
    cwd = workspace.path;
    if (input.workingDir !== null && input.workingDir !== undefined) {
      cwd = contained(workspace.path, input.workingDir);
    }
  }

  if (input.kind !== "BACKEND") {
    const verdict = evaluateCommand(input.argv ?? [], workspace !== null ? workspacePolicyOverride(workspace) : undefined);
    if (verdict.verdict === "DENY") throw forbidden(verdict.reason, { command: input.argv?.[0] });
    if (verdict.verdict === "REQUIRE_APPROVAL" && options.policyCleared !== true) {
      throw forbidden(`${verdict.reason} Submit it through the approval flow.`, { command: input.argv?.[0] });
    }
  }

  return { workspace, cwd };
}

/** Runner-side re-check: DENY and escaped working directories never run. */
export function assertRunnable(
  job: { kind: string; workingDir: string | null },
  argv: string[] | undefined,
  workspace: Workspace | null,
): void {
  if (job.kind !== "BACKEND") {
    const verdict = evaluateCommand(argv ?? [], workspace !== null ? workspacePolicyOverride(workspace) : undefined);
    if (verdict.verdict === "DENY") throw forbidden(verdict.reason);
  }
  if (workspace !== null && job.workingDir !== null) contained(workspace.path, job.workingDir);
}
