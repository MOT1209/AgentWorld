/**
 * Testing/QA tools -- how a QA agent creates, runs, inspects and settles
 * tests. Everything routes through the TestingEngine (which routes through the
 * execution queue); nothing here executes a process directly.
 */
import { z } from "zod";
import { PERMISSIONS, type Permission } from "../../../security/src/permissions.js";
import type { ToolDefinition, ToolExecutionContext } from "../types.js";
import { runTestSuite, listTestRuns, settleTestRunFromExecution } from "../../../factory/src/index.js";
import { forbidden, validationError } from "../../../shared/src/index.js";
import type { DbClient } from "../../../database/src/index.js";
import { filterByScope } from "../../../security/src/company-refs.js";
import { agentCompanyScope } from "../agent-scope.js";
import { canWriteWorkspace, requireWorkspace, type WorkspaceActorContext } from "../../../workspace/src/index.js";

function actorCtx(context: ToolExecutionContext): WorkspaceActorContext {
  return {
    actor: context.actor,
    correlationId: context.correlationId,
    permissions: context.permissions as ReadonlySet<Permission>,
    ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
  };
}

/**
 * The command adapter runs real argv inside the workspace (via the execution
 * queue), exactly like terminal.exec -- so it needs the same write/execute
 * ACL check terminal.exec, fs.write and git.commit all apply. Without this,
 * any caller holding testing.run could run a command in a workspace it does
 * not own.
 */
async function assertCanRunIn(db: DbClient, context: ToolExecutionContext, workspaceId: string): Promise<void> {
  const workspace = await requireWorkspace(db, workspaceId);
  if (!(await canWriteWorkspace(db, workspace, actorCtx(context)))) {
    throw forbidden("No execute access to this workspace", { workspaceId });
  }
}

const SELF_CONTAINED_TOOL_SUITES = ["BROWSER", "MOBILE", "SECURITY", "PERFORMANCE"] as const;
type QaSuite = (typeof SELF_CONTAINED_TOOL_SUITES)[number] | "UNIT" | "INTEGRATION" | "E2E";

function toolAdapterFor(suite: string | undefined, hasCommand: boolean, hasUrl: boolean): "command" | "http" | "browser" | "mobile" | "security" | "performance" {
  if (hasCommand) {
    if (suite === "BROWSER") return "browser";
    if (suite === "MOBILE") return "mobile";
    if (suite === "SECURITY") return "security";
    if (suite === "PERFORMANCE") return "performance";
    return "command";
  }
  if (hasUrl) return "http";
  if (suite === "BROWSER") return "browser";
  if (suite === "MOBILE") return "mobile";
  if (suite === "SECURITY") return "security";
  return "performance";
}

export const testingRunTool: ToolDefinition<{
  workspaceId?: string;
  command?: string[];
  url?: string;
  name?: string;
  suite?: string;
}> = {
  name: "testing.run",
  description:
    "Queue a test run. Give command (argv inside the workspace, e.g. [\"npx\",\"vitest\",\"run\"]) or url (HTTP smoke probe). BROWSER/MOBILE/SECURITY/PERFORMANCE suites may run without either: SECURITY runs platform self-checks, PERFORMANCE measures latency, BROWSER/MOBILE record honest simulated rows when no runner exists.",
  inputSchema: z.object({
    workspaceId: z.string().max(100).optional(),
    command: z.array(z.string().max(200)).max(20).optional(),
    url: z.string().max(500).optional(),
    name: z.string().max(120).optional(),
    suite: z.enum(["UNIT", "INTEGRATION", "E2E", "BROWSER", "MOBILE", "SECURITY", "PERFORMANCE"]).optional(),
  }),
  requiredPermission: PERMISSIONS.TESTING_RUN,
  risk: "MEDIUM",
  async execute(context, input) {
    const suite = input.suite as QaSuite | undefined;
    if (input.command === undefined && input.url === undefined) {
      if (suite === undefined || !(SELF_CONTAINED_TOOL_SUITES as readonly string[]).includes(suite)) {
        throw validationError("Provide either command or url (BROWSER/MOBILE/SECURITY/PERFORMANCE suites may run without one)");
      }
    }
    if (input.command !== undefined && input.workspaceId === undefined) {
      throw validationError("A command run needs a workspaceId");
    }
    // Any suite that names a workspace can end up running the command
    // adapter in it (see toolAdapterFor); require write access up front
    // regardless of which suite was requested.
    if (input.workspaceId !== undefined) {
      await assertCanRunIn(context.db, context, input.workspaceId);
    }
    const run = await runTestSuite(context.db, {
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      taskId: null,
      agentId: context.agentId ?? null,
      sessionId: null,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(suite !== undefined
        ? { suite: suite as "UNIT" | "INTEGRATION" | "E2E" | "BROWSER" | "MOBILE" | "SECURITY" | "PERFORMANCE" }
        : {}),
      ...(input.command !== undefined ? { argv: input.command } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      adapter: toolAdapterFor(suite, input.command !== undefined, input.url !== undefined),
    });
    return {
      data: { testRunId: run.id, status: run.status, suite: run.suite, executionId: run.executionId },
      summary: `Test run ${run.id} recorded (${run.suite}/${run.status})`,
    };
  },
};

export const testingGetTool: ToolDefinition<{ testRunId: string }> = {
  name: "testing.get",
  description: "Get a test run's status, summary counts and labelled evidence (observed/inferred/hypothesis).",
  inputSchema: z.object({ testRunId: z.string().max(100) }),
  requiredPermission: PERMISSIONS.TESTING_READ,
  risk: "LOW",
  async execute(context, input) {
    const run = await context.db.testRun.findUnique({ where: { id: input.testRunId } });
    if (run === null) throw validationError(`TestRun '${input.testRunId}' not found`);
    return {
      data: {
        id: run.id,
        suite: run.suite,
        adapter: run.adapter,
        name: run.name,
        status: run.status,
        summary: safeJson(run.summary),
        evidence: safeJson(run.evidence),
        executionId: run.executionId,
        durationMs: run.durationMs,
      },
      summary: `Test run ${run.id}: ${run.status}`,
    };
  },
};

export const testingListTool: ToolDefinition<{ taskId?: string; workspaceId?: string }> = {
  name: "testing.list",
  description: "List recent test runs for a task or workspace.",
  inputSchema: z.object({
    taskId: z.string().max(100).optional(),
    workspaceId: z.string().max(100).optional(),
  }),
  requiredPermission: PERMISSIONS.TESTING_READ,
  risk: "LOW",
  async execute(context, input) {
    const listed = await listTestRuns(context.db, {
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    });
    // A run has no company of its own: it belongs to its task, workspace and agent.
    const runs = context.agentId === undefined
      ? listed
      : await filterByScope(context.db, await agentCompanyScope(context.db, context.agentId), listed, (run) => ({
        agentId: run.agentId,
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      }));
    return {
      data: {
        runs: runs.map((run) => ({ id: run.id, suite: run.suite, status: run.status, name: run.name, createdAt: run.createdAt })),
      },
      summary: `${runs.length} test runs`,
    };
  },
};

/** QA loop: settle a queued run once its execution job finished. */
export const testingSettleTool: ToolDefinition<{
  testRunId: string;
  executionStatus: string;
  exitCode: number | null;
}> = {
  name: "testing.settle",
  description: "Record the outcome of a finished test execution against its TestRun (used by the QA fix loop).",
  inputSchema: z.object({
    testRunId: z.string().max(100),
    executionStatus: z.enum(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]),
    exitCode: z.number().int().min(-1).max(65_535).nullable(),
  }),
  requiredPermission: PERMISSIONS.TESTING_RUN,
  risk: "LOW",
  async execute(context, input) {
    const run = await settleTestRunFromExecution(context.db, input.testRunId, {
      exitCode: input.exitCode,
      status: input.executionStatus,
    });
    return {
      data: { testRunId: run.id, status: run.status },
      summary: `Test run ${run.id} settled: ${run.status}`,
    };
  },
};

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const testingTools = [testingRunTool, testingGetTool, testingListTool, testingSettleTool];
