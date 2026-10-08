/**
 * TestingEngine -- one interface, several adapters, evidence discipline.
 *
 * Adapters:
 *   - `command`  runs an argv command inside a workspace through the
 *                execution queue (vitest, pytest, any test runner) -- the
 *                only adapter that executes anything.
 *   - `http`     probes a URL's availability/status (smoke tests).
 *   - `testerarmy` reserves the TesterArmy E2E integration point: it parses
 *                natural-language test scripts and reports UNSUPPORTED until
 *                the e2e engine is installed, so callers get an honest
 *                "not available" instead of a fake pass.
 *
 * Evidence on every TestRun follows the factory rules: OBSERVED (the raw
 * exit/output), INFERRED (derived status/counts), HYPOTHESIS (what a further
 * run could confirm). Nothing is reported CONFIRMED without a passing run.
 */
import type { DbClient } from "../../database/src/index.js";
import type { TestRun } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { enqueueExecution } from "../../execution/src/index.js";
import { getConfig, newCorrelationId, SYSTEM_ACTOR, toJson, validationError } from "../../shared/src/index.js";

export const TEST_ADAPTERS = ["command", "http", "testerarmy"] as const;
export type TestAdapter = (typeof TEST_ADAPTERS)[number];

export interface StartTestInput {
  workspaceId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  name?: string;
  /** command adapter: argv to run; http adapter: URL to probe. */
  argv?: string[];
  url?: string;
}

function suiteForAdapter(adapter: TestAdapter, argv?: string[], url?: string): string {
  if (adapter === "http") return "INTEGRATION";
  const joined = (argv ?? []).join(" ").toLowerCase();
  if (joined.includes("e2e") || joined.includes("playwright") || joined.includes("cypress")) return "E2E";
  if (joined.includes("pytest") || joined.includes("vitest") || joined.includes("jest") || joined.includes("go test")) return "UNIT";
  if (url !== undefined) return "INTEGRATION";
  return "INTEGRATION";
}

export async function runTestSuite(
  db: DbClient,
  input: StartTestInput & { adapter?: TestAdapter; suite?: "UNIT" | "INTEGRATION" | "E2E" | "BROWSER" | "MOBILE" | "SECURITY" | "PERFORMANCE" },
): Promise<TestRun> {
  const correlationId = newCorrelationId();
  const adapter = input.adapter ?? (input.argv !== undefined ? "command" : input.url !== undefined ? "http" : "command");

  if (adapter === "testerarmy") {
    // Honest unsupported state: the tester-army e2e engine is not vendored.
    // When it lands, this branch maps its script -> engine call -> artifacts.
    const row = await db.testRun.create({
      data: {
        suite: input.suite ?? "E2E",
        adapter: "testerarmy",
        name: input.name ?? "TesterArmy E2E",
        status: "ERROR",
        summary: toJson({ passed: 0, failed: 0, skipped: 0, total: 0 }),
        evidence: toJson({
          observed: ["TesterArmy E2E adapter requested"],
          inferred: ["Engine is not installed in this deployment"],
          hypothesis: ["Install the e2e engine and re-run to obtain real results"],
        }),
        workspaceId: input.workspaceId ?? null,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        correlationId,
      },
    });
    await emitRecorded(db, row);
    return row;
  }

  if (adapter === "command") {
    const argv = input.argv;
    if (argv === undefined || argv.length === 0) {
      throw validationError("command adapter requires argv (e.g. [\"npx\",\"vitest\",\"run\"])");
    }
    if (input.workspaceId === undefined || input.workspaceId === null) {
      throw validationError("command adapter requires a workspace");
    }
    const job = await enqueueExecution(db, {
      kind: "COMMAND",
      command: JSON.stringify(argv),
      workspaceId: input.workspaceId,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
      actor: SYSTEM_ACTOR,
      correlationId,
      timeoutMs: Math.min(getConfig().factory.maxRuntimeMs, 900_000),
    });
    const row = await db.testRun.create({
      data: {
        suite: input.suite ?? suiteForAdapter("command", argv),
        adapter: "command",
        name: input.name ?? argv.join(" ").slice(0, 120),
        status: "QUEUED",
        summary: toJson({ passed: 0, failed: 0, skipped: 0, total: 0 }),
        evidence: toJson({
          observed: [`ExecutionJob ${job.id} queued with argv ${argv.join(" ").slice(0, 120)}`],
          inferred: [],
          hypothesis: ["Run completes -> suite passes; run fails -> inspect spooled output"],
        }),
        workspaceId: input.workspaceId,
        executionId: job.id,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        correlationId,
      },
    });
    await emitRecorded(db, row);
    return row;
  }

  // http adapter: synchronous availability probe (bounded, no redirect trust).
  const url = input.url;
  if (url === undefined || !/^https?:\/\//i.test(url)) {
    throw validationError("http adapter requires an absolute http(s) URL");
  }
  const started = Date.now();
  let status: number | null = null;
  let observed = "request failed";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    clearTimeout(timer);
    status = response.status;
    observed = `HTTP ${response.status} from ${new URL(url).host}`;
  } catch (error) {
    observed = error instanceof Error ? error.message : String(error);
  }
  const durationMs = Date.now() - started;
  const passed = status !== null && status >= 200 && status < 400;
  const row = await db.testRun.create({
    data: {
      suite: input.suite ?? suiteForAdapter("http", undefined, url),
      adapter: "http",
      name: input.name ?? `HTTP probe ${new URL(url).host}`,
      status: passed ? "PASSED" : "FAILED",
      summary: toJson({ passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0, total: 1 }),
      evidence: toJson({
        observed: [observed],
        inferred: [passed ? "Endpoint reachable" : "Endpoint unreachable or erroring"],
        hypothesis: passed ? [] : ["If the service is expected to be up, verify deployment health"],
      }),
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
      durationMs,
      startedAt: new Date(started),
      finishedAt: new Date(),
      correlationId,
    },
  });
  await emitRecorded(db, row);
  return row;
}

async function emitRecorded(db: DbClient, row: TestRun): Promise<void> {
  await eventBus
    .publishAndDispatch(db, {
      type: EVENT_TYPES.TEST_RUN_RECORDED,
      actor: SYSTEM_ACTOR,
      correlationId: row.correlationId ?? newCorrelationId(),
      targetType: "TestRun",
      targetId: row.id,
      payload: {
        testRunId: row.id,
        suite: row.suite,
        adapter: row.adapter,
        status: row.status,
        taskId: row.taskId,
      },
    })
    .catch(() => undefined);
}

/**
 * Settles a TestRun from its finished ExecutionJob. Called by the fix-loop
 * (or a worker callback) once the job reaches a terminal status.
 */
export async function settleTestRunFromExecution(
  db: DbClient,
  testRunId: string,
  outcome: { exitCode: number | null; status: string; stdoutPath?: string | null },
): Promise<TestRun> {
  const row = await db.testRun.findUnique({ where: { id: testRunId } });
  if (row === null) throw validationError("TestRun not found");
  if (row.status !== "QUEUED" && row.status !== "RUNNING") return row;
  const passed = outcome.exitCode === 0;
  const updated = await db.testRun.update({
    where: { id: testRunId },
    data: {
      status: passed ? "PASSED" : outcome.status === "TIMEOUT" ? "TIMEOUT" : "FAILED",
      summary: toJson({ passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0, total: 1 }),
      evidence: toJson({
        observed: [`ExecutionJob finished with status ${outcome.status}, exitCode ${String(outcome.exitCode)}`],
        inferred: [passed ? "Command exited zero" : "Command reported failure"],
        hypothesis: passed ? [] : ["Inspect spooled stdout/stderr artifacts for the failing step"],
      }),
      rawPath: outcome.stdoutPath ?? row.rawPath,
      finishedAt: new Date(),
    },
  });
  await emitRecorded(db, updated);
  return updated;
}

export async function listTestRuns(
  db: DbClient,
  query: { taskId?: string; workspaceId?: string; suite?: string } = {},
): Promise<TestRun[]> {
  return db.testRun.findMany({
    where: {
      ...(query.taskId !== undefined ? { taskId: query.taskId } : {}),
      ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}),
      ...(query.suite !== undefined ? { suite: query.suite } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
