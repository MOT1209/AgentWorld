/**
 * Managed-project abstraction for the Software Factory.
 *
 * A FactoryRun is the pipeline; a *project* is the operator-facing view of
 * it: repository coordinates, lifecycle state, team, tasks, tests, review,
 * pull request and deployment in one object. The pipeline's own stage machine
 * (INTAKE..COMPLETED, see shared enums) is never altered here -- this module
 * MAPS it onto the managed-project lifecycle so both views stay consistent:
 *
 *   INTAKE            -> DISCOVERING
 *   ANALYZING         -> ANALYZING
 *   PLANNING          -> PLANNING (+ TEAM_FORMING once a team is suggested)
 *   BUILDING          -> DEVELOPING (READY once the branch exists)
 *   TESTING           -> TESTING
 *   FIXING            -> FIXING (BLOCKED when the fix budget is exhausted)
 *   REVIEWING         -> REVIEWING (READY_FOR_PR when review passes)
 *   AWAITING_APPROVAL -> PR_OPEN when a PR exists, else READY_FOR_PR
 *                      -> WAITING_APPROVAL once review is requested
 *   COMPLETED         -> MERGED (mergedBy present) -> DEPLOYED (a deployment
 *                        with status DEPLOYED exists)
 *   FAILED            -> FAILED
 *   CANCELLED         -> CANCELLED
 *
 * Everything returned is read from the run row and its linked records;
 * nothing here writes, transitions, or approves.
 */
import type { DbClient } from "../../database/src/index.js";
import { validationError } from "../../shared/src/index.js";
import type { DeploymentRecord } from "./deploy.js";

export type ProjectLifecycle =
  | "DISCOVERING"
  | "ANALYZING"
  | "PLANNING"
  | "TEAM_FORMING"
  | "READY"
  | "DEVELOPING"
  | "TESTING"
  | "REVIEWING"
  | "FIXING"
  | "READY_FOR_PR"
  | "PR_OPEN"
  | "WAITING_APPROVAL"
  | "MERGED"
  | "DEPLOYED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

export interface ProjectStatus {
  factoryRunId: string;
  repoUrl: string;
  lifecycle: ProjectLifecycle;
  stage: string;
  companyId: string;
  repository: { owner: string | null; repo: string | null; branch: string | null };
  workspaceId: string | null;
  team: Array<{ agentId: string; name: string; roleKey: string }>;
  task: { id: string; title: string; status: string } | null;
  tests: Array<{ id: string; suite: string; adapter: string; name: string; status: string }>;
  review: { passed: boolean | null; failedChecks: string[] };
  pullRequest: { url: string | null; number: number | null; mergedBy: string | null; mergedAt: string | null };
  deployments: DeploymentRecord[];
  bounds: { fixAttempts: number; maxFixAttempts: number; maxRuntimeMs: number; maxModelCalls: number };
  blocked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function deploymentsOf(github: Record<string, unknown>): DeploymentRecord[] {
  const raw = github.deployments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is DeploymentRecord =>
    entry !== null && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string",
  );
}

/**
 * Maps a pipeline stage plus run evidence onto the managed-project
 * lifecycle. Pure function of the run row (plus its github/stats JSON).
 */
export function lifecycleFor(
  stage: string,
  github: Record<string, unknown>,
  stats: Record<string, unknown>,
  config: Record<string, unknown>,
): ProjectLifecycle {
  const deployments = deploymentsOf(github);
  const deployed = deployments.some((deployment) => deployment.status === "DEPLOYED");
  const mergedBy = asString(github.mergedBy);
  const prNumber = asNumber(github.prNumber);
  const prUrl = asString(github.prUrl);
  const fixAttempts = asNumber(stats.fixAttempts) ?? 0;
  const maxFixAttempts = asNumber(config.maxFixAttempts) ?? 3;

  switch (stage) {
    case "INTAKE":
      return "DISCOVERING";
    case "ANALYZING":
      return "ANALYZING";
    case "PLANNING": {
      const team = github.team;
      return team !== undefined && team !== null ? "TEAM_FORMING" : "PLANNING";
    }
    case "BUILDING":
      return asString(github.branch) !== null ? "READY" : "DEVELOPING";
    case "TESTING":
      return "TESTING";
    case "FIXING":
      return fixAttempts >= maxFixAttempts ? "BLOCKED" : "FIXING";
    case "REVIEWING": {
      const review = github.review;
      if (review !== null && typeof review === "object" && (review as { passed?: unknown }).passed === true) {
        return "READY_FOR_PR";
      }
      return "REVIEWING";
    }
    case "AWAITING_APPROVAL":
      if (prNumber !== null || prUrl !== null) return "PR_OPEN";
      return "WAITING_APPROVAL";
    case "COMPLETED":
      if (deployed) return "DEPLOYED";
      if (mergedBy !== null) return "MERGED";
      return "READY_FOR_PR";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "DISCOVERING";
  }
}

/** Full managed-project view of a factory run. Read-only. */
export async function getProjectStatus(db: DbClient, runId: string): Promise<ProjectStatus> {
  const run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");

  const github = parseJson(run.github);
  const stats = parseJson(run.stats);
  const config = parseJson(run.config);
  const lifecycle = lifecycleFor(run.currentStage, github, stats, config);

  let team: ProjectStatus["team"] = [];
  let task: ProjectStatus["task"] = null;
  let review: ProjectStatus["review"] = { passed: null, failedChecks: [] };
  if (run.taskId !== null) {
    const taskRow = await db.task.findUnique({
      where: { id: run.taskId },
      select: { id: true, title: true, status: true, assigneeAgentId: true },
    });
    if (taskRow !== null) {
      task = { id: taskRow.id, title: taskRow.title, status: taskRow.status };
      if (taskRow.assigneeAgentId !== null) {
        const agent = await db.agent.findUnique({
          where: { id: taskRow.assigneeAgentId },
          select: { id: true, name: true, roleKey: true },
        });
        if (agent !== null) team = [{ agentId: agent.id, name: agent.name, roleKey: agent.roleKey }];
      }
    }
    const reviews = await db.taskReview.findMany({
      where: { taskId: run.taskId },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    const latest = reviews[0];
    if (latest !== undefined) {
      review = {
        passed: latest.outcome === "APPROVED",
        failedChecks: latest.outcome === "APPROVED" ? [] : [latest.outcome],
      };
    }
  }
  const storedReview = github.review;
  if (storedReview !== null && typeof storedReview === "object") {
    const passed = (storedReview as { passed?: unknown }).passed;
    const failedChecks = (storedReview as { failedChecks?: unknown }).failedChecks;
    review = {
      passed: typeof passed === "boolean" ? passed : review.passed,
      failedChecks: Array.isArray(failedChecks) ? failedChecks.filter((entry): entry is string => typeof entry === "string") : review.failedChecks,
    };
  }

  const tests = await db.testRun.findMany({
    where: {
      ...(run.taskId !== null ? { taskId: run.taskId } : {}),
      ...(run.workspaceId !== null ? { workspaceId: run.workspaceId } : {}),
    },
    select: { id: true, suite: true, adapter: true, name: true, status: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return {
    factoryRunId: run.id,
    repoUrl: run.repoUrl,
    lifecycle,
    stage: run.currentStage,
    companyId: run.companyId,
    repository: {
      owner: asString(github.owner),
      repo: asString(github.repo),
      branch: asString(github.branch),
    },
    workspaceId: run.workspaceId,
    team,
    task,
    tests,
    review,
    pullRequest: {
      url: asString(github.prUrl),
      number: asNumber(github.prNumber),
      mergedBy: asString(github.mergedBy),
      mergedAt: asString(github.mergedAt),
    },
    deployments: deploymentsOf(github),
    bounds: {
      fixAttempts: asNumber(stats.fixAttempts) ?? 0,
      maxFixAttempts: asNumber(config.maxFixAttempts) ?? 3,
      maxRuntimeMs: asNumber(config.maxRuntimeMs) ?? 0,
      maxModelCalls: asNumber(config.maxModelCalls) ?? 0,
    },
    blocked: lifecycle === "BLOCKED" || lifecycle === "FAILED",
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
