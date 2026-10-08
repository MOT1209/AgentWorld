/**
 * Pre-PR review gate for the Software Factory.
 *
 * Before a run may open a pull request it must clear every check below.
 * The gate is read-only except for two writes: it records its verdict on
 * the run's github JSON (`review: { passed, checks, at }`) and emits
 * FACTORY_REVIEW_RECORDED so the decision is auditable. It never opens the
 * PR itself -- that stays in the pipeline's REVIEWING stage.
 *
 * Checks (all evidence-backed, none advisory-only):
 *   1. analysis-present   -- the analyzer produced a scored report.
 *   2. plan-present       -- PLANNING left derived tasks behind.
 *   3. tests-pass         -- the latest test run for the bound task or
 *                            workspace has status PASSED. A run with no test
 *                            evidence fails this check (never "no tests, ok").
 *   4. no-secret-leak     -- the analyzer did not observe a committed .env.
 *   5. fix-budget-left    -- exhausted budgets fail loudly instead of
 *                            queuing work the pipeline cannot pay for.
 *   6. branch-set         -- a working branch is recorded for the PR.
 *
 * Security checks are never weakened to make the pipeline pass: a failing
 * check fails the gate, full stop.
 */
import type { DbClient } from "../../database/src/index.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { newCorrelationId, toJson, validationError, type ActorRef } from "../../shared/src/index.js";

export interface ReviewCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ReviewVerdict {
  factoryRunId: string;
  passed: boolean;
  checks: ReviewCheck[];
  failedChecks: string[];
  correlationId: string;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Runs the review gate. Records the verdict; never opens a PR. */
export async function reviewRun(
  db: DbClient,
  runId: string,
  ctx: { actor: ActorRef; correlationId?: string },
): Promise<ReviewVerdict> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");

  const analysis = parseJson(run.analysis);
  const plan = parseJson(run.plan);
  const github = parseJson(run.github);
  const stats = parseJson(run.stats);
  const config = parseJson(run.config);
  const checks: ReviewCheck[] = [];

  const score = typeof analysis.score === "number" ? analysis.score : 0;
  checks.push({
    name: "analysis-present",
    passed: score > 0,
    detail: score > 0 ? `analyzer score ${score}` : "no scored analyzer report on the run",
  });

  const derived = Array.isArray(plan.derivedTasks) ? plan.derivedTasks.length : 0;
  checks.push({
    name: "plan-present",
    passed: derived > 0,
    detail: derived > 0 ? `${derived} derived task(s)` : "planning left no derived tasks",
  });

  // Unbound runs own no evidence: matching an arbitrary TestRun would let
  // a run pass the gate on someone else's green run.
  const lastTest = run.taskId === null && run.workspaceId === null
    ? null
    : await db.testRun.findFirst({
      where: {
        ...(run.taskId !== null ? { taskId: run.taskId } : {}),
        ...(run.workspaceId !== null ? { workspaceId: run.workspaceId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
  checks.push({
    name: "tests-pass",
    passed: lastTest !== null && lastTest.status === "PASSED",
    detail: lastTest === null
      ? "no test evidence for the bound task/workspace"
      : `latest run ${lastTest.id} (${lastTest.suite}/${lastTest.adapter}) is ${lastTest.status}`,
  });

  const debt = Array.isArray(analysis.technicalDebt)
    ? analysis.technicalDebt.filter((entry): entry is string => typeof entry === "string")
    : [];
  const leakedEnv = debt.some((entry) => entry.includes(".env file committed"));
  checks.push({
    name: "no-secret-leak",
    passed: !leakedEnv,
    detail: leakedEnv ? "analyzer observed a committed .env file" : "no committed secrets observed",
  });

  const fixAttempts = typeof stats.fixAttempts === "number" ? stats.fixAttempts : 0;
  const maxFixAttempts = typeof config.maxFixAttempts === "number" ? config.maxFixAttempts : 3;
  checks.push({
    name: "fix-budget-left",
    passed: fixAttempts < maxFixAttempts,
    detail: `${fixAttempts}/${maxFixAttempts} fix attempts spent`,
  });

  const branch = typeof github.branch === "string" && github.branch !== "" ? github.branch : null;
  checks.push({
    name: "branch-set",
    passed: branch !== null,
    detail: branch !== null ? `working branch ${branch}` : "no working branch recorded",
  });

  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  const verdict: ReviewVerdict = {
    factoryRunId: run.id,
    passed: failedChecks.length === 0,
    checks,
    failedChecks,
    correlationId,
  };

  await db.factoryRun.update({
    where: { id: run.id },
    data: {
      github: toJson({
        ...github,
        review: { passed: verdict.passed, checks, failedChecks, at: new Date().toISOString() },
      }),
    },
  });
  await eventBus
    .publishAndDispatch(db, {
      type: EVENT_TYPES.FACTORY_REVIEW_RECORDED,
      actor: ctx.actor,
      correlationId,
      targetType: "FactoryRun",
      targetId: run.id,
      payload: { factoryRunId: run.id, passed: verdict.passed, failedChecks },
    })
    .catch(() => undefined);
  return verdict;
}
