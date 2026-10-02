/**
 * Terminal tools.
 *
 * Agents run real commands inside their workspace directory — argv arrays,
 * never shell strings, so metacharacters are inert data. Every execution is
 * permission-checked (workspace write), policy-gated (CommandPolicy),
 * bounded (timeout, output cap, locked cwd), and audited like any tool.
 * Live processes are tracked by execution id and can be killed.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { forbidden, notFound } from "../../../shared/src/index.js";
import { canWriteWorkspace, requireWorkspace } from "../../../workspace/src/index.js";
import { evaluateCommand, filterEnv, type WorkspacePolicyOverride } from "../command-policy.js";
import { terminalProcesses } from "../process-manager.js";
import type { ToolDefinition } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BYTES = 65_536;
const MAX_BYTES = 1_048_576;

function policyOverrideFor(workspace: { environment: string }): WorkspacePolicyOverride | undefined {
  try {
    const env = JSON.parse(workspace.environment) as { policy?: WorkspacePolicyOverride };
    return env.policy;
  } catch {
    return undefined;
  }
}

export const terminalExecTool: ToolDefinition<{
  workspaceId: string;
  argv: string[];
  timeoutMs?: number;
  maxBytes?: number;
  env?: Record<string, string>;
}> = {
  name: "terminal.exec",
  description:
    "Run a command inside one of your workspaces and capture stdout, stderr, " +
    "and the exit code. Commands are argv arrays (no shell); the working " +
    "directory is always the workspace root. Destructive commands are refused; " +
    "publishing commands and commands outside the routine allow-list are held " +
    "for human approval.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    argv: z.array(z.string().min(1).max(2000)).min(1).max(25),
    timeoutMs: z.number().int().min(500).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    maxBytes: z.number().int().min(1024).max(MAX_BYTES).default(DEFAULT_MAX_BYTES),
    env: z.record(z.string(), z.string().max(4000)).optional(),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_EXECUTE,
  risk: "MEDIUM",
  approvalPolicy: async (input, context) => {
    let override: WorkspacePolicyOverride | undefined;
    try {
      const workspace = await context.db.workspace.findUnique({ where: { id: input.workspaceId } });
      if (workspace !== null) override = policyOverrideFor(workspace);
    } catch {
      override = undefined;
    }
    const verdict = evaluateCommand(input.argv, override);
    if (verdict.verdict !== "REQUIRE_APPROVAL") return null;
    return { risk: verdict.risk, reason: verdict.reason };
  },
  async execute(context, input) {
    const workspace = await requireWorkspace(context.db, input.workspaceId);
    if (!(await canWriteWorkspace(context.db, workspace, {
      actor: context.actor,
      correlationId: context.correlationId,
      permissions: context.permissions,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
    }))) {
      throw forbidden("No execute access to this workspace", { workspaceId: workspace.id });
    }

    const verdict = evaluateCommand(input.argv, policyOverrideFor(workspace));
    if (verdict.verdict === "DENY") {
      throw forbidden(verdict.reason, { workspaceId: workspace.id, command: input.argv[0] });
    }

    const result = await terminalProcesses.exec({
      workspaceId: workspace.id,
      command: input.argv,
      cwd: workspace.path,
      env: filterEnv(input.env),
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
    });

    return {
      data: {
        executionId: result.executionId,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      },
      summary:
        `exit ${result.exitCode ?? result.signal ?? "?"} in ${result.durationMs}ms` +
        (result.timedOut ? " (timed out, killed)" : "") +
        (result.truncated ? " (output truncated)" : ""),
    };
  },
};

export const terminalKillTool: ToolDefinition<{ executionId: string }> = {
  name: "terminal.kill",
  description: "Stop one of your running terminal executions by id.",
  inputSchema: z.object({ executionId: z.string().min(1).max(120) }),
  requiredPermission: PERMISSIONS.WORKSPACE_EXECUTE,
  risk: "LOW",
  async execute(context, input) {
    const killed = terminalProcesses.kill(input.executionId);
    if (!killed) throw notFound("Live execution", input.executionId);
    return {
      data: { executionId: input.executionId, killed: true },
      summary: `Execution ${input.executionId} signalled to stop`,
    };
  },
};

export const terminalTools = [terminalExecTool, terminalKillTool];
