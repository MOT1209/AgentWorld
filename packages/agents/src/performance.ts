/**
 * Performance Center -- measured history, not opinions.
 *
 * Every number here is computed from evidence already in the database:
 * Task outcomes (completed/failed/cancelled, rework counts, durations),
 * TaskReview verdicts, and ExecutionJob results. No hidden decay curves, no
 * arbitrary multipliers: if an agent looks unreliable, the rows that say so
 * are queryable. A company or department summary aggregates the same evidence
 * across its agents.
 */
import { validationError } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";

const TASK_SUCCESS_STATES = ["COMPLETED"];

export interface AgentPerformanceSummary {
  agentId: string;
  window: string;
  tasks: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    successRate: number | null;
    reworkCount: number;
    avgDurationMs: number | null;
  };
  reviews: { total: number; approved: number; needsChanges: number; rejected: number; approvalRate: number | null };
  executions: { total: number; completed: number; failed: number; timeout: number; cancelled: number; successRate: number | null };
  aiUsage: { calls: number; errors: number; estimatedCostMinor: number };
}

function rate(part: number, total: number): number | null {
  return total === 0 ? null : Math.round((part / total) * 100);
}

export async function agentPerformance(
  db: DbClient,
  agentId: string,
  query: { since?: Date } = {},
): Promise<AgentPerformanceSummary> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
  if (agent === null) throw validationError(`Agent '${agentId}' does not exist`);

  const taskWhere = {
    assigneeAgentId: agentId,
    ...(query.since !== undefined ? { createdAt: { gte: query.since } } : {}),
  };
  const [total, completed, failed, cancelled, reworkAgg, durations, reviews, execRows, aiRows] =
    await Promise.all([
      db.task.count({ where: taskWhere }),
      db.task.count({ where: { ...taskWhere, status: { in: TASK_SUCCESS_STATES } } }),
      db.task.count({ where: { ...taskWhere, status: "FAILED" } }),
      db.task.count({ where: { ...taskWhere, status: "CANCELLED" } }),
      db.task.aggregate({ where: taskWhere, _sum: { reworkCount: true } }),
      db.task.findMany({
        where: { ...taskWhere, startedAt: { not: null }, completedAt: { not: null } },
        select: { startedAt: true, completedAt: true },
      }),
      db.taskReview.findMany({
        where: query.since !== undefined ? { createdAt: { gte: query.since }, task: { assigneeAgentId: agentId } } : { task: { assigneeAgentId: agentId } },
        select: { outcome: true },
      }),
      db.executionJob.findMany({
        where: { agentId, ...(query.since !== undefined ? { scheduledAt: { gte: query.since } } : {}) },
        select: { status: true },
      }),
      db.aiUsage.findMany({
        where: { agentId, ...(query.since !== undefined ? { createdAt: { gte: query.since } } : {}) },
        select: { status: true, estimatedCostMinor: true },
      }),
    ]);

  const durationsMs = durations.map((t) =>
    (t.completedAt as Date).getTime() - (t.startedAt as Date).getTime(),
  );
  const avgDurationMs = durationsMs.length === 0
    ? null
    : Math.round(durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length);

  const approved = reviews.filter((r) => r.outcome === "APPROVED").length;
  const needsChanges = reviews.filter((r) => r.outcome === "NEEDS_CHANGES").length;
  const rejected = reviews.filter((r) => r.outcome === "REJECTED").length;

  const execCompleted = execRows.filter((e) => e.status === "COMPLETED").length;
  const execFailed = execRows.filter((e) => e.status === "FAILED").length;
  const execTimeout = execRows.filter((e) => e.status === "TIMEOUT").length;
  const execCancelled = execRows.filter((e) => e.status === "CANCELLED").length;

  const aiCalls = aiRows.length;
  const aiErrors = aiRows.filter((r) => r.status !== "OK").length;
  const aiCost = aiRows.reduce((sum, r) => sum + r.estimatedCostMinor, 0);

  return {
    agentId,
    window: query.since !== undefined ? `since-${query.since.toISOString()}` : "all-time",
    tasks: {
      total,
      completed,
      failed,
      cancelled,
      successRate: rate(completed, total),
      reworkCount: reworkAgg._sum.reworkCount ?? 0,
      avgDurationMs,
    },
    reviews: {
      total: reviews.length,
      approved,
      needsChanges,
      rejected,
      approvalRate: rate(approved, reviews.length),
    },
    executions: {
      total: execRows.length,
      completed: execCompleted,
      failed: execFailed,
      timeout: execTimeout,
      cancelled: execCancelled,
      successRate: rate(execCompleted, execRows.length),
    },
    aiUsage: { calls: aiCalls, errors: aiErrors, estimatedCostMinor: aiCost },
  };
}

/** A few named agents at once, for the dashboard leaderboard. */
export async function agentsPerformance(
  db: DbClient,
  agentIds: string[],
  query: { since?: Date } = {},
): Promise<AgentPerformanceSummary[]> {
  return Promise.all(agentIds.map((id) => agentPerformance(db, id, query)));
}

/** Company-wide rollup: per-agent summaries under one company. */
export async function companyPerformance(
  db: DbClient,
  companyId: string,
  query: { since?: Date } = {},
): Promise<{ companyId: string; window: string; agents: AgentPerformanceSummary[] }> {
  const members = await db.companyMember.findMany({
    where: { companyId },
    select: { agentId: true },
  });
  const agents = await agentsPerformance(db, members.map((m) => m.agentId), query);
  return { companyId, window: query.since !== undefined ? `since-${query.since.toISOString()}` : "all-time", agents };
}
