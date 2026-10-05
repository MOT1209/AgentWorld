/**
 * Execution tools.
 *
 * Agents queue, inspect and cancel ExecutionJobs. Nothing runs inline: the
 * tools only create or read rows; the worker executes them. Creation goes
 * through `enqueueExecution`, which re-applies the workspace path guard and
 * CommandPolicy, so a tool call can never skip a gate the executor's own
 * approval hook already applied.
 */
import { z } from "zod";
import { cancelExecution, enqueueExecution } from "../../../execution/src/index.js";
import { evaluateCommand, type WorkspacePolicyOverride } from "../command-policy.js";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { forbidden, notFound } from "../../../shared/src/index.js";
import { canReadWorkspace, canWriteWorkspace, requireWorkspace } from "../../../workspace/src/index.js";
import type { ExecutionJob } from "../../../database/src/types.js";
import type { ToolDefinition, ToolExecutionContext } from "../types.js";

const CommandSchema = z.union([
  z.array(z.string().min(1).max(2000)).min(1).max(25),
  z.object({ prompt: z.string().min(1).max(20_000) }),
]);

function actorCtx(context: ToolExecutionContext) {
  return {
    actor: context.actor,
    correlationId: context.correlationId,
    permissions: context.permissions,
    ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
  };
}

function overrideFor(workspace: { environment: string }): WorkspacePolicyOverride | undefined {
  try {
    return (JSON.parse(workspace.environment) as { policy?: WorkspacePolicyOverride }).policy;
  } catch {
    return undefined;
  }
}

/** Operational view only: no command rows and no output. */
function view(job: ExecutionJob) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    backendId: job.backendId,
    workspaceId: job.workspaceId,
    sessionId: job.sessionId,
    taskId: job.taskId,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    exitCode: job.exitCode,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

async function requireJobAccess(
  context: ToolExecutionContext,
  jobId: string,
  mode: "read" | "write",
): Promise<ExecutionJob> {
  const job = await context.db.executionJob.findUnique({ where: { id: jobId } });
  if (job === null) throw notFound("ExecutionJob", jobId);
  let allowed = job.agentId !== null && job.agentId === context.agentId;
  if (!allowed && job.workspaceId !== null) {
    const workspace = await requireWorkspace(context.db, job.workspaceId);
    allowed =
      mode === "read"
        ? await canReadWorkspace(context.db, workspace, actorCtx(context))
        : await canWriteWorkspace(context.db, workspace, actorCtx(context));
  }
  // Same answer as "unknown id" so other workspaces' jobs cannot be probed.
  if (!allowed) throw notFound("ExecutionJob", jobId);
  return job;
}

type CreateInput = {
  workspaceId: string;
  command: string[] | { prompt: string };
  backendId?: "local" | "mock" | "opencode";
  taskId?: string;
  sessionId?: string;
  timeoutMs?: number;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
};

export const executionCreateTool: ToolDefinition<CreateInput> = {
  name: "execution.create",
  description:
    "Queue an execution job in one of your workspaces. Give an argv array " +
    "(runs a command) or {prompt} (runs the OpenCode backend). The job runs " +
    "asynchronously: poll execution.get for the result. Destructive commands " +
    "are refused; unknown commands and prompt-driven runs are held for approval.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    command: CommandSchema,
    backendId: z.enum(["local", "mock", "opencode"]).optional(),
    taskId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    maxAttempts: z.number().int().min(1).max(5).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_EXECUTE,
  risk: "MEDIUM",
  approvalPolicy: async (input, context) => {
    if (!Array.isArray(input.command)) {
      // Unattended agent work in a workspace: a human approves the instructions.
      return { risk: "HIGH", reason: "A prompt-driven backend run needs approved instructions." };
    }
    let override: WorkspacePolicyOverride | undefined;
    try {
      const workspace = await context.db.workspace.findUnique({ where: { id: input.workspaceId } });
      if (workspace !== null) override = overrideFor(workspace);
    } catch {
      override = undefined;
    }
    const verdict = evaluateCommand(input.command, override);
    return verdict.verdict === "REQUIRE_APPROVAL" ? { risk: verdict.risk, reason: verdict.reason } : null;
  },
  async execute(context, input) {
    const workspace = await requireWorkspace(context.db, input.workspaceId);
    if (!(await canWriteWorkspace(context.db, workspace, actorCtx(context)))) {
      throw forbidden("No execute access to this workspace", { workspaceId: workspace.id });
    }
    const isPrompt = !Array.isArray(input.command);
    const job = await enqueueExecution(context.db, {
      kind: isPrompt ? "BACKEND" : "COMMAND",
      command: JSON.stringify(input.command),
      actor: context.actor,
      correlationId: context.correlationId,
      backendId: input.backendId ?? (isPrompt ? "opencode" : "local"),
      workspaceId: workspace.id,
      agentId: context.agentId ?? null,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      // The executor already ran approvalPolicy (or replayed an approved call).
      policyCleared: true,
    });
    return { data: { job: view(job) }, summary: `Queued execution ${job.id}` };
  },
};

export const executionGetTool: ToolDefinition<{ executionId: string }> = {
  name: "execution.get",
  description: "Get the status and result summary of an execution job.",
  inputSchema: z.object({ executionId: z.string().min(1).max(120) }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const job = await requireJobAccess(context, input.executionId, "read");
    return { data: { job: view(job) }, summary: `Execution ${job.id} is ${job.status}` };
  },
};

export const executionListTool: ToolDefinition<{ workspaceId?: string; status?: string; limit?: number }> = {
  name: "execution.list",
  description: "List execution jobs in a workspace you can read (or the ones you created).",
  inputSchema: z.object({
    workspaceId: z.string().min(1).optional(),
    status: z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    if (input.workspaceId !== undefined) {
      const workspace = await requireWorkspace(context.db, input.workspaceId);
      if (!(await canReadWorkspace(context.db, workspace, actorCtx(context)))) {
        throw notFound("Workspace", input.workspaceId);
      }
    }
    const jobs = await context.db.executionJob.findMany({
      where: {
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        // Without a workspace filter an agent only sees jobs it created itself.
        ...(input.workspaceId === undefined && context.agentId !== undefined ? { agentId: context.agentId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit ?? 25,
    });
    return { data: { jobs: jobs.map(view) }, summary: `${jobs.length} execution(s)` };
  },
};

export const executionCancelTool: ToolDefinition<{ executionId: string; reason?: string }> = {
  name: "execution.cancel",
  description:
    "Cancel an execution job: one that is still queued is cancelled outright; " +
    "one running in this server is signalled to stop and settled as CANCELLED.",
  inputSchema: z.object({
    executionId: z.string().min(1).max(120),
    reason: z.string().min(1).max(300).default("Cancelled by agent"),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_EXECUTE,
  risk: "LOW",
  async execute(context, input) {
    const job = await requireJobAccess(context, input.executionId, "write");
    const outcome = await cancelExecution(context.db, job.id, input.reason ?? "Cancelled by agent", {
      actor: context.actor,
      correlationId: context.correlationId,
    });
    if (outcome === "missing") throw notFound("ExecutionJob", job.id);
    if (outcome === "busy") {
      throw forbidden("Execution is neither queued nor running here; orphan recovery will settle it");
    }
    const stopping = outcome === "cancelling";
    return {
      data: { executionId: job.id, cancelled: true, stopping },
      summary: stopping ? `Stop signalled to ${job.id}` : `Cancelled ${job.id}`,
    };
  },
};

export const executionTools = [executionCreateTool, executionGetTool, executionListTool, executionCancelTool];
