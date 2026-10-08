/**
 * Autonomous fix loop -- bounded failure analysis plus fix-task creation.
 *
 *   Test -> Failure -> Failure Analysis (this file) -> Fix Task ->
 *     Agent Fix (delegation engine) -> Retest (pipeline TESTING)
 *
 * Bounds (never an infinite loop):
 *   - Fix tasks are refused once stats.fixAttempts reaches the run's
 *     maxFixAttempts (the pipeline owns the counter on advance()).
 *   - Analysis is read-only and side-effect-free; only createFixTask writes,
 *     and it writes exactly one task per call through the governed Task
 *     Engine (which emits TASK_CREATED + audit rows itself).
 *   - When the budget is exhausted the caller marks the run FAILED/BLOCKED;
 *     this module never transitions the run itself.
 *
 * Failure evidence is preserved verbatim: the analysis quotes the failed
 * TestRun (suite, status, summary, observed lines) instead of summarizing
 * it away.
 */
import type { DbClient } from "../../database/src/index.js";
import { newCorrelationId, toJson, validationError } from "../../shared/src/index.js";
import { createTask, type TaskActorContext } from "../../tasks/src/index.js";

export interface FailureAnalysis {
  factoryRunId: string;
  stage: string;
  verdict: "ACTIONABLE_FAILURE" | "NO_EVIDENCE" | "BUDGET_EXHAUSTED" | "ALREADY_PASSING";
  errorCode: string;
  safeMessage: string;
  attempt: number;
  maxFixAttempts: number;
  budgetRemaining: number;
  lastTestRun: {
    id: string;
    suite: string;
    adapter: string;
    name: string;
    status: string;
    summary: Record<string, unknown>;
    observed: string[];
  } | null;
  suggestedFix: { title: string; description: string; acceptance: string[] } | null;
  correlationId: string;
}

const SUITE_TASK_TYPE: Record<string, string> = {
  UNIT: "TESTING",
  INTEGRATION: "TESTING",
  E2E: "TESTING",
  BROWSER: "TESTING",
  MOBILE: "TESTING",
  SECURITY: "REVIEW",
  PERFORMANCE: "ANALYSIS",
};

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Read-only failure analysis. Never writes, never transitions, never loops. */
export async function analyzeFailure(db: DbClient, runId: string): Promise<FailureAnalysis> {
  const correlationId = newCorrelationId();
  const run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");

  const stats = parseJson(run.stats);
  const config = parseJson(run.config);
  const attempt = typeof stats.fixAttempts === "number" ? stats.fixAttempts : 0;
  const maxFixAttempts = typeof config.maxFixAttempts === "number" ? config.maxFixAttempts : 3;

  if (run.taskId === null && run.workspaceId === null) {
    // Unbound runs have no evidence scope: matching an arbitrary TestRun
    // would blame the run for someone else's failure.
    return {
      factoryRunId: run.id,
      stage: run.currentStage,
      verdict: "NO_EVIDENCE",
      errorCode: "FACTORY_NO_TEST_EVIDENCE",
      safeMessage: "No task or workspace is bound to this run, so no test evidence can belong to it. Bind one and queue a test run first.",
      attempt,
      maxFixAttempts,
      budgetRemaining: Math.max(0, maxFixAttempts - attempt),
      lastTestRun: null,
      suggestedFix: null,
      correlationId,
    };
  }

  const lastTest = await db.testRun.findFirst({
    where: {
      ...(run.taskId !== null ? { taskId: run.taskId } : {}),
      ...(run.workspaceId !== null ? { workspaceId: run.workspaceId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  if (attempt >= maxFixAttempts) {
    return {
      factoryRunId: run.id,
      stage: run.currentStage,
      verdict: "BUDGET_EXHAUSTED",
      errorCode: "FACTORY_FIX_BUDGET_EXHAUSTED",
      safeMessage: `Fix budget exhausted (${attempt}/${maxFixAttempts} attempts). Mark the run FAILED or BLOCKED; no further fix tasks will be created.`,
      attempt,
      maxFixAttempts,
      budgetRemaining: 0,
      lastTestRun: null,
      suggestedFix: null,
      correlationId,
    };
  }

  if (lastTest === null) {
    return {
      factoryRunId: run.id,
      stage: run.currentStage,
      verdict: "NO_EVIDENCE",
      errorCode: "FACTORY_NO_TEST_EVIDENCE",
      safeMessage: "No test evidence yet. Queue a test run before asking for a fix task.",
      attempt,
      maxFixAttempts,
      budgetRemaining: maxFixAttempts - attempt,
      lastTestRun: null,
      suggestedFix: null,
      correlationId,
    };
  }

  if (lastTest.status === "PASSED") {
    return {
      factoryRunId: run.id,
      stage: run.currentStage,
      verdict: "ALREADY_PASSING",
      errorCode: "FACTORY_ALREADY_PASSING",
      safeMessage: "The latest test run passed; no fix task is needed.",
      attempt,
      maxFixAttempts,
      budgetRemaining: maxFixAttempts - attempt,
      lastTestRun: null,
      suggestedFix: null,
      correlationId,
    };
  }

  const evidence = parseJson(lastTest.evidence);
  const observed = stringList(evidence.observed);
  const errorCode = lastTest.status === "TIMEOUT"
    ? "FACTORY_TEST_TIMEOUT"
    : lastTest.status === "ERROR"
      ? "FACTORY_TEST_ERROR"
      : "FACTORY_TEST_FAILED";
  const firstObserved = observed[0] ?? "no observed output";
  return {
    factoryRunId: run.id,
    stage: run.currentStage,
    verdict: "ACTIONABLE_FAILURE",
    errorCode,
    safeMessage: `${lastTest.suite} suite ${lastTest.status.toLowerCase()}: ${firstObserved.slice(0, 200)}`,
    attempt,
    maxFixAttempts,
    budgetRemaining: maxFixAttempts - attempt,
    lastTestRun: {
      id: lastTest.id,
      suite: lastTest.suite,
      adapter: lastTest.adapter,
      name: lastTest.name,
      status: lastTest.status,
      summary: parseJson(lastTest.summary),
      observed: observed.slice(0, 10),
    },
    suggestedFix: {
      title: `Fix ${lastTest.suite} failure: ${lastTest.name.slice(0, 80)}`,
      description: [
        `Factory run ${run.id} (${run.repoUrl}) reported a ${lastTest.suite} failure.`,
        `TestRun ${lastTest.id} via ${lastTest.adapter}: ${firstObserved.slice(0, 500)}`,
        "Reproduce in the run workspace, fix the root cause, and re-run the same suite.",
      ].join("\n"),
      acceptance: [
        `The ${lastTest.suite} suite passes in the run workspace`,
        "No new failures in the previously passing suites",
        "Failure evidence from the previous run is addressed, not deleted",
      ],
    },
    correlationId,
  };
}

/**
 * Creates exactly one fix task from the current failure analysis. Refuses
 * when there is nothing actionable or the budget is exhausted. The created
 * task is a child of the run's task when one is bound.
 */
export async function createFixTask(
  db: DbClient,
  runId: string,
  ctx: TaskActorContext,
): Promise<{ taskId: string; analysis: FailureAnalysis }> {
  const analysis = await analyzeFailure(db, runId);
  if (analysis.verdict !== "ACTIONABLE_FAILURE" || analysis.suggestedFix === null || analysis.lastTestRun === null) {
    throw validationError(`No actionable failure for run ${runId}: ${analysis.verdict}`);
  }
  const run = await db.factoryRun.findUniqueOrThrow({ where: { id: runId } });
  const task = await createTask(
    db,
    {
      title: analysis.suggestedFix.title.slice(0, 200),
      description: analysis.suggestedFix.description.slice(0, 4000),
      priority: "HIGH",
      type: SUITE_TASK_TYPE[analysis.lastTestRun.suite] ?? "TESTING",
      companyId: run.companyId,
      ...(run.taskId !== null ? { parentTaskId: run.taskId } : {}),
      metadata: {
        factoryRunId: run.id,
        fixAttempt: analysis.attempt + 1,
        failingTestRunId: analysis.lastTestRun.id,
        acceptance: analysis.suggestedFix.acceptance,
      },
    },
    { ...ctx, correlationId: ctx.correlationId ?? analysis.correlationId },
  );
  await db.factoryRun.update({
    where: { id: run.id },
    data: {
      stats: toJson({ ...parseJson(run.stats), lastFixTaskId: task.id }),
    },
  });
  return { taskId: task.id, analysis };
}
