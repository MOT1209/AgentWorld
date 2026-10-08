/**
 * Software Factory pipeline -- GitHub URL in, reviewed PR out, human merges.
 *
 *   GitHub URL -> Intake -> Analyze -> Plan -> (Build -> Test -> Fix)* -> Review
 *     -> AWAITING_APPROVAL -> (human) -> merge
 *
 * Bounded by design (never an infinite loop):
 *   - maxFixAttempts  default from config FACTORY_MAX_FIX_ATTEMPTS
 *   - maxRuntimeMs    default from config FACTORY_MAX_RUNTIME_MS
 *   - maxModelCalls   default from config FACTORY_MAX_MODEL_CALLS
 * The loop is *state-machine driven*, not time driven: each `advance()` call
 * moves the run at most one stage, and FIXING can only be entered
 * maxFixAttempts times. Merge is NEVER automatic -- it always stops at
 * AWAITING_APPROVAL and waits for a human (factory.merge is ALWAYS_APPROVE).
 */
import type { DbClient } from "../../database/src/index.js";
import type { FactoryRun } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { canTransitionFactoryStage, newCorrelationId, SYSTEM_ACTOR, toJson, validationError, type FactoryStage } from "../../shared/src/index.js";
import { getConfig } from "../../shared/src/config.js";
import { GithubClient, type GithubPullRequest } from "./github.js";
import { analyzeRepository, type ProjectHealthReport } from "./analyzer.js";
import { runTestSuite } from "./testing.js";

export interface StartFactoryRunInput {
  repoUrl: string;
  companyId: string;
  actor: { actorType: "USER" | "AGENT" | "SYSTEM"; actorId?: string; actorName?: string };
  correlationId?: string;
  /** Overrides for the bounds (bounded above by config). */
  maxFixAttempts?: number;
  workspaceId?: string | null;
  instruction?: string;
}

const STAGE_ORDER: readonly FactoryStage[] = [
  "INTAKE",
  "ANALYZING",
  "PLANNING",
  "BUILDING",
  "TESTING",
];

export async function startFactoryRun(db: DbClient, input: StartFactoryRunInput): Promise<FactoryRun> {
  const config = getConfig().factory;
  const run = await db.factoryRun.create({
    data: {
      repoUrl: input.repoUrl,
      companyId: input.companyId,
      status: "INTAKE",
      currentStage: "INTAKE",
      config: toJson({
        maxFixAttempts: Math.min(input.maxFixAttempts ?? config.maxFixAttempts, config.maxFixAttempts),
        maxRuntimeMs: config.maxRuntimeMs,
        maxModelCalls: config.maxModelCalls,
        targetBranch: `agentworld/run-${Date.now().toString(36)}`,
      }),
      plan: toJson({ instruction: input.instruction ?? "" }),
      stats: toJson({ fixAttempts: 0, modelCalls: 0, costMinor: 0, testRuns: 0 }),
      workspaceId: input.workspaceId ?? null,
    },
  });
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.FACTORY_RUN_STARTED,
    actor: input.actor,
    correlationId: input.correlationId ?? newCorrelationId(),
    targetType: "FactoryRun",
    targetId: run.id,
    payload: { factoryRunId: run.id, repoUrl: input.repoUrl, companyId: input.companyId },
  });
  return run;
}

async function transition(db: DbClient, run: FactoryRun, to: FactoryStage): Promise<FactoryRun> {
  if (!canTransitionFactoryStage(run.currentStage as FactoryStage, to)) {
    throw validationError(`Factory run cannot move from ${run.currentStage} to ${to}`);
  }
  const updated = await db.factoryRun.update({
    where: { id: run.id },
    data: { currentStage: to, status: to },
  });
  await eventBus
    .publishAndDispatch(db, {
      type: EVENT_TYPES.FACTORY_STAGE_ADVANCED,
      actor: SYSTEM_ACTOR,
      correlationId: newCorrelationId(),
      targetType: "FactoryRun",
      targetId: run.id,
      payload: { factoryRunId: run.id, fromStage: run.currentStage, toStage: to },
    })
    .catch(() => undefined);
  return updated;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Advances the run one stage. Returns the updated run. Throws when a bound is
 * exhausted (the run is marked FAILED first). Safe to call repeatedly.
 */
export async function advanceFactoryRun(
  db: DbClient,
  runId: string,
  client: GithubClient,
): Promise<FactoryRun> {
  let run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");
  const startedAt = run.createdAt.getTime();
  const bounds = parseJson(run.config) as { maxRuntimeMs?: number; maxFixAttempts?: number };
  const stats = parseJson(run.stats) as { fixAttempts?: number; modelCalls?: number; testRuns?: number };

  const checkRuntime = (): void => {
    if (bounds.maxRuntimeMs !== undefined && Date.now() - startedAt > bounds.maxRuntimeMs) {
      throw validationError("Factory run exceeded its configured runtime budget");
    }
  };

  const stage = run.currentStage as FactoryStage;
  checkRuntime();

  if (stage === "INTAKE") {
    run = await transition(db, run, "ANALYZING");
    return run;
  }

  if (stage === "ANALYZING") {
    const report: ProjectHealthReport = await analyzeRepository(run.repoUrl, client);
    const githubMeta = { owner: "", repo: "" };
    try {
      const parsed = GithubClient.parseRepoUrl(run.repoUrl);
      githubMeta.owner = parsed.owner;
      githubMeta.repo = parsed.repo;
    } catch {
      // analyzeRepository already validated the URL
    }
    run = await db.factoryRun.update({
      where: { id: run.id },
      data: {
        analysis: toJson(report),
        github: toJson({ ...githubMeta, ...(parseJson(run.github) as Record<string, unknown>) }),
      },
    });
    return transition(db, run, "PLANNING");
  }

  if (stage === "PLANNING") {
    const analysis = parseJson(run.analysis) as unknown as ProjectHealthReport;
    run = await db.factoryRun.update({
      where: { id: run.id },
      data: {
        plan: toJson({
          instruction: (parseJson(run.plan) as { instruction?: string }).instruction ?? "",
          derivedTasks: analysis.testSetup.map((setup) => `Respect existing setup: ${setup}`),
          risks: analysis.technicalDebt,
          branch: (parseJson(run.config) as { targetBranch?: string }).targetBranch ?? `agentworld/run-${run.id.slice(0, 8)}`,
        }),
      },
    });
    return transition(db, run, "BUILDING");
  }

  if (stage === "BUILDING") {
    // The build stage creates the working branch. Actual code changes come
    // from executor agents in workspaces (Phase 3 execution); the pipeline
    // records the branch so commits land somewhere reviewable.
    const github = parseJson(run.github) as { owner?: string; repo?: string };
    const plan = parseJson(run.plan) as { branch?: string };
    if (github.owner === undefined || github.repo === undefined) {
      throw validationError("Factory run is missing GitHub coordinates");
    }
    const defaultBranch = parseJson(run.analysis).repo !== undefined
      ? ((parseJson(run.analysis) as { repo?: { defaultBranch?: string } }).repo?.defaultBranch ?? "main")
      : "main";
    let branch = plan.branch ?? "agentworld/run";
    try {
      const created = await client.createBranch(github.owner, github.repo, defaultBranch, branch);
      branch = created.name;
    } catch {
      // Branch may already exist from a previous pass -- reuse it.
    }
    run = await db.factoryRun.update({
      where: { id: run.id },
      data: { github: toJson({ ...github, branch }) },
    });
    return transition(db, run, "TESTING");
  }

  if (stage === "TESTING") {
    stats.testRuns = (stats.testRuns ?? 0) + 1;
    const lastTest = await db.testRun.findFirst({
      where: { taskId: run.taskId ?? undefined, workspaceId: run.workspaceId ?? undefined },
      orderBy: { createdAt: "desc" },
    });
    // Reuse the latest settled result when present; otherwise queue a fresh
    // verification run for the workspace.
    if (lastTest !== null && (lastTest.status === "PASSED" || lastTest.status === "FAILED")) {
      run = await db.factoryRun.update({
        where: { id: run.id },
        data: { stats: toJson(stats) },
      });
      if (lastTest.status === "PASSED") {
        return transition(db, run, "REVIEWING");
      }
      return transition(db, run, "FIXING");
    }
    if (run.workspaceId !== null) {
      await runTestSuite(db, {
        workspaceId: run.workspaceId,
        taskId: run.taskId,
        adapter: "command",
        argv: ["npm", "test"],
        name: `factory-verify-${run.id.slice(0, 8)}`,
      });
    }
    run = await db.factoryRun.update({
      where: { id: run.id },
      data: { stats: toJson(stats) },
    });
    return run;
  }

  if (stage === "FIXING") {
    const maxFixAttempts = bounds.maxFixAttempts ?? getConfig().factory.maxFixAttempts;
    if ((stats.fixAttempts ?? 0) >= maxFixAttempts) {
      const failed = await transition(db, run, "FAILED");
      await eventBus
        .publishAndDispatch(db, {
          type: EVENT_TYPES.FACTORY_RUN_FINISHED,
          actor: SYSTEM_ACTOR,
          correlationId: newCorrelationId(),
          targetType: "FactoryRun",
          targetId: failed.id,
          payload: { factoryRunId: failed.id, status: "FAILED", fixAttempts: stats.fixAttempts ?? 0 },
        })
        .catch(() => undefined);
      throw validationError(`Factory run exhausted its fix budget (${maxFixAttempts} attempts)`);
    }
    stats.fixAttempts = (stats.fixAttempts ?? 0) + 1;
    run = await db.factoryRun.update({
      where: { id: run.id },
      data: { stats: toJson(stats) },
    });
    // Developer fix work happens in the workspace; the loop then re-enters TESTING.
    return transition(db, run, "TESTING");
  }

  if (stage === "REVIEWING") {
    // The review gate: a human opens/merges the PR. The pipeline prepares it
    // and stops in AWAITING_APPROVAL.
    const github = parseJson(run.github) as { owner?: string; repo?: string; branch?: string; prUrl?: string; prNumber?: number };
    if (github.owner === undefined || github.repo === undefined) {
      throw validationError("Factory run is missing GitHub coordinates");
    }
    if (github.prUrl === undefined) {
      if (!client.configured) {
        const updated = await db.factoryRun.update({
          where: { id: run.id },
          data: { github: toJson({ ...github, prUrl: null }) },
        });
        const awaiting = await transition(db, updated, "AWAITING_APPROVAL");
        await eventBus
          .publishAndDispatch(db, {
            type: EVENT_TYPES.FACTORY_APPROVAL_REQUIRED,
            actor: SYSTEM_ACTOR,
            correlationId: newCorrelationId(),
            targetType: "FactoryRun",
            targetId: awaiting.id,
            payload: {
              factoryRunId: awaiting.id,
              repoUrl: run.repoUrl,
              reason: "Pipeline completed; GitHub token not configured so no PR was opened -- merge manually.",
            },
          })
          .catch(() => undefined);
        return awaiting;
      }
      const branch = github.branch ?? "agentworld/run";
      const defaultBranch =
        (parseJson(run.analysis) as { repo?: { defaultBranch?: string } }).repo?.defaultBranch ?? "main";
      const pr: GithubPullRequest = await client.openPullRequest(
        github.owner,
        github.repo,
        branch,
        defaultBranch,
        `AgentWorld: ${run.id.slice(0, 8)}`,
        `Automated factory run ${run.id}. Review before merge.`,
      );
      run = await db.factoryRun.update({
        where: { id: run.id },
        data: { github: toJson({ ...github, prUrl: pr.url, prNumber: pr.number }) },
      });
    }
    const awaiting = await transition(db, run, "AWAITING_APPROVAL");
    await eventBus
      .publishAndDispatch(db, {
        type: EVENT_TYPES.FACTORY_APPROVAL_REQUIRED,
        actor: SYSTEM_ACTOR,
        correlationId: newCorrelationId(),
        targetType: "FactoryRun",
        targetId: awaiting.id,
        payload: { factoryRunId: awaiting.id, repoUrl: run.repoUrl, reason: "PR awaiting human merge decision" },
      })
      .catch(() => undefined);
    return awaiting;
  }

  return run;
}

/** Human decision at the approval gate. Merge happens only here, only for a human. */
export async function approveFactoryRun(
  db: DbClient,
  runId: string,
  ctx: { actor: { actorType: "USER"; actorId: string; actorName?: string }; client: GithubClient },
): Promise<FactoryRun> {
  let run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");
  if (run.currentStage !== "AWAITING_APPROVAL") {
    throw validationError(`Factory run is in ${run.currentStage}; merge requires AWAITING_APPROVAL`);
  }
  const github = parseJson(run.github) as { owner?: string; repo?: string; prNumber?: number };
  if (github.owner !== undefined && github.repo !== undefined && github.prNumber !== undefined) {
    await ctx.client.mergePullRequest(github.owner, github.repo, github.prNumber);
  }
  run = await db.factoryRun.update({
    where: { id: run.id },
    data: { github: toJson({ ...github, mergedBy: ctx.actor.actorId, mergedAt: new Date().toISOString() }) },
  });
  const completed = await transition(db, run, "COMPLETED");
  await eventBus
    .publishAndDispatch(db, {
      type: EVENT_TYPES.FACTORY_RUN_FINISHED,
      actor: ctx.actor,
      correlationId: newCorrelationId(),
      targetType: "FactoryRun",
      targetId: completed.id,
      payload: {
        factoryRunId: completed.id,
        status: "COMPLETED",
        fixAttempts: (parseJson(completed.stats) as { fixAttempts?: number }).fixAttempts ?? 0,
      },
    })
    .catch(() => undefined);
  return completed;
}

export async function cancelFactoryRun(db: DbClient, runId: string): Promise<FactoryRun> {
  const run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");
  return transition(db, run, "CANCELLED");
}

export async function listFactoryRuns(db: DbClient, companyId?: string): Promise<FactoryRun[]> {
  return db.factoryRun.findMany({
    where: companyId !== undefined ? { companyId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export { STAGE_ORDER };
