/**
 * Git tools.
 *
 * Read-only inspection plus local-only writes (checkout, commit). There is
 * deliberately NO push tool: branches leave the machine only through human
 * approval (terminal `git push` is approval-held by CommandPolicy, and
 * merging stays a human act). Everything runs with argv (no shell) inside
 * the workspace directory, bounded like any terminal execution.
 */
import { relative } from "node:path";
import { z } from "zod";
import { PERMISSIONS, type Permission } from "../../../security/src/permissions.js";
import { forbidden, validationError } from "../../../shared/src/index.js";
import {
  canReadWorkspace,
  canWriteWorkspace,
  requireWorkspace,
  resolveInRoot,
  type WorkspaceActorContext,
} from "../../../workspace/src/index.js";
import type { DbClient } from "../../../database/src/index.js";
import type { ToolDefinition, ToolExecutionContext } from "../types.js";
import type { Workspace } from "../../../database/src/types.js";
import { getCommandRunner } from "../command-runner.js";
import { filterEnv } from "../command-policy.js";

const GIT_HARDENING = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "protocol.ext.allow=never",
  "-c", "core.sshCommand=false",
] as const;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 65_536;

function actorCtx(context: ToolExecutionContext): WorkspaceActorContext {
  return {
    actor: context.actor,
    correlationId: context.correlationId,
    permissions: context.permissions as ReadonlySet<Permission>,
    ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
  };
}

async function forRead(db: DbClient, context: ToolExecutionContext, workspaceId: string): Promise<Workspace> {
  const workspace = await requireWorkspace(db, workspaceId);
  if (!(await canReadWorkspace(db, workspace, actorCtx(context)))) {
    throw forbidden("No read access to this workspace", { workspaceId });
  }
  return workspace;
}

async function forWrite(db: DbClient, context: ToolExecutionContext, workspaceId: string): Promise<Workspace> {
  const workspace = await requireWorkspace(db, workspaceId);
  if (!(await canWriteWorkspace(db, workspace, actorCtx(context)))) {
    throw forbidden("No write access to this workspace", { workspaceId });
  }
  return workspace;
}

async function git(workspace: Workspace, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await getCommandRunner().exec({
    workspaceId: workspace.id,
    // Repo-local config is agent-writable (fs.write can touch .git/config), so
    // neutralise the settings that make git launch programs on its own.
    command: ["git", ...GIT_HARDENING, ...args],
    cwd: workspace.path,
    env: filterEnv(),
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: GIT_MAX_BYTES,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function assertGitOk(workspace: Workspace, result: { exitCode: number | null; stdout: string; stderr: string }, what: string): string {
  if (result.exitCode !== 0) {
    throw validationError(`git ${what} failed: ${result.stderr.slice(0, 500) || `exit ${String(result.exitCode)}`}`, {
      workspaceId: workspace.id,
    });
  }
  return result.stdout;
}

export const gitStatusTool: ToolDefinition<{ workspaceId: string }> = {
  name: "git.status",
  description: "Show working-tree status and current branch for the workspace repo.",
  inputSchema: z.object({ workspaceId: z.string().min(1) }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await forRead(context.db, context, input.workspaceId);
    const status = await git(workspace, ["status", "--porcelain=v1", "-b"]);
    const out = assertGitOk(workspace, status, "status");
    const [branchLine, ...files] = out.split("\n").filter((line) => line.length > 0);
    return {
      data: { branch: branchLine ?? null, files },
      summary: `${files.length} changed file(s)${branchLine !== undefined ? ` on ${branchLine}` : ""}`,
    };
  },
};

export const gitBranchTool: ToolDefinition<{ workspaceId: string }> = {
  name: "git.branch",
  description: "List local branches of the workspace repo.",
  inputSchema: z.object({ workspaceId: z.string().min(1) }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await forRead(context.db, context, input.workspaceId);
    const branches = await git(workspace, ["branch", "--list"]);
    const out = assertGitOk(workspace, branches, "branch");
    return {
      data: { branches: out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0) },
      summary: "Listed branches",
    };
  },
};

export const gitCheckoutTool: ToolDefinition<{ workspaceId: string; branch: string; create?: boolean }> = {
  name: "git.checkout",
  description: "Switch branches in the workspace repo, optionally creating the branch.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    branch: z.string().min(1).max(120),
    create: z.boolean().default(false),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "MEDIUM",
  async execute(context, input) {
    const workspace = await forWrite(context.db, context, input.workspaceId);
    if (input.branch.startsWith("-")) throw validationError("Invalid branch name");
    const args = input.create ? ["checkout", "-b", input.branch] : ["checkout", input.branch];
    const result = await git(workspace, args);
    const out = assertGitOk(workspace, result, "checkout");
    return { data: { branch: input.branch, output: out }, summary: `Checked out ${input.branch}` };
  },
};

export const gitDiffTool: ToolDefinition<{ workspaceId: string; staged?: boolean; stat?: boolean }> = {
  name: "git.diff",
  description: "Show workspace changes (stat by default; full diff on request).",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    staged: z.boolean().default(false),
    stat: z.boolean().default(true),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await forRead(context.db, context, input.workspaceId);
    const args = ["diff", ...(input.staged ? ["--cached"] : []), ...(input.stat ? ["--stat"] : [])];
    const result = await git(workspace, args);
    const out = assertGitOk(workspace, result, "diff");
    return { data: { diff: out.slice(0, 8000) }, summary: out.length === 0 ? "No changes" : "Changes present" };
  },
};

export const gitLogTool: ToolDefinition<{ workspaceId: string; limit?: number }> = {
  name: "git.log",
  description: "Show recent commits in the workspace repo.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await forRead(context.db, context, input.workspaceId);
    const result = await git(workspace, ["log", "--oneline", "-n", String(input.limit)]);
    const out = assertGitOk(workspace, result, "log");
    return {
      data: { commits: out.split("\n").filter((line) => line.length > 0) },
      summary: "Listed recent commits",
    };
  },
};

export const gitAddTool: ToolDefinition<{ workspaceId: string; paths: string[] }> = {
  name: "git.add",
  description: "Stage specific workspace paths for the next commit.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    paths: z.array(z.string().min(1).max(500)).min(1).max(100),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await forWrite(context.db, context, input.workspaceId);
    // Every path must resolve inside the workspace (no traversal, no symlink escape),
    // then goes after `--` so it can never be parsed as an option.
    const relPaths = input.paths.map((path) => relative(workspace.path, resolveInRoot(workspace.path, path)) || ".");
    const result = await git(workspace, ["add", "--", ...relPaths]);
    assertGitOk(workspace, result, "add");
    return { data: { staged: relPaths }, summary: `Staged ${relPaths.length} path(s)` };
  },
};

export const gitCommitTool: ToolDefinition<{ workspaceId: string; message: string; addAll?: boolean }> = {
  name: "git.commit",
  description:
    "Commit staged (or all tracked, with addAll) workspace changes locally. " +
    "Never pushes: branches leave the machine only through human approval.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    message: z.string().min(5).max(500),
    addAll: z.boolean().default(false),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "MEDIUM",
  async execute(context, input) {
    const workspace = await forWrite(context.db, context, input.workspaceId);
    if (input.addAll) {
      const add = await git(workspace, ["add", "-A"]);
      assertGitOk(workspace, add, "add");
    }
    const author = context.agentId ?? "kingworld";
    const result = await git(workspace, [
      "-c",
      "user.name=KingWorld Agent",
      "-c",
      "user.email=agents@kingworld.local",
      "commit",
      "-m",
      `${input.message}\n\nAgent: ${author}`,
    ]);
    const out = assertGitOk(workspace, result, "commit");
    return { data: { output: out.slice(0, 1000) }, summary: "Committed workspace changes" };
  },
};

export const gitTools = [gitStatusTool, gitAddTool, gitBranchTool, gitCheckoutTool, gitDiffTool, gitLogTool, gitCommitTool];
