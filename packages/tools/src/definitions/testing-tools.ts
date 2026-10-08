/**
 * Testing/QA tools -- how a QA agent creates, runs, inspects and settles
 * tests. Everything routes through the TestingEngine (which routes through the
 * execution queue); nothing here executes a process directly.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import type { ToolDefinition } from "../types.js";
import { runTestSuite, listTestRuns, settleTestRunFromExecution } from "../../../factory/src/index.js";
import { validationError } from "../../../shared/src/index.js";

export const testingRunTool: ToolDefinition<{
  workspaceId: string;
  command?: string[];
  url?: string;
  name?: string;
  suite?: string;
}> = {
  name: "testing.run",
  description:
    "Queue a test run. Give either command (argv inside the workspace, e.g. [\"npx\",\"vitest\",\"run\"]) or url (HTTP smoke probe). Returns a TestRun id tracked through the execution queue.",
  inputSchema: z.object({
    workspaceId: z.string().max(100),
    command: z.array(z.string().max(200)).max(20).optional(),
    url: z.string().max(500).optional(),
    name: z.string().max(120).optional(),
    suite: z.enum(["UNIT", "INTEGRATION", "E2E", "BROWSER", "MOBILE", "SECURITY", "PERFORMANCE"]).optional(),
  }),
  requiredPermission: PERMISSIONS.TESTING_RUN,
  risk: "MEDIUM",
  async execute(context, input) {
    if (input.command === undefined && input.url === undefined) {
      throw validationError("Provide either command or url");
    }
    const run = await runTestSuite(context.db, {
      workspaceId: input.workspaceId,
      taskId: null,
      agentId: context.agentId ?? null,
      sessionId: null,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.suite !== undefined
        ? { suite: input.suite as "UNIT" | "INTEGRATION" | "E2E" | "BROWSER" | "MOBILE" | "SECURITY" | "PERFORMANCE" }
        : {}),
      ...(input.command !== undefined ? { argv: input.command } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.command !== undefined ? { adapter: "command" as const } : { adapter: "http" as const }),
    });
    return {
      data: { testRunId: run.id, status: run.status, suite: run.suite, executionId: run.executionId },
      summary: `Test run ${run.id} queued (${run.suite})`,
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
    const runs = await listTestRuns(context.db, {
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    });
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
