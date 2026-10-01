/**
 * Workload scoring for delegation.
 *
 * Pure functions: no database, no clock, no randomness. The delegation
 * service gathers AgentWorkload rows and asks these questions, which keeps
 * the "who gets the next task" policy reviewable in one file and testable
 * without fixtures.
 *
 * Policy in one sentence: among agents that are capable, active, and under
 * their concurrency limit, give the work to whoever is least busy -- with a
 * stable tie-break so a cold start does not shuffle the queue every call.
 */
import type { ConcurrencyLevel } from "../../shared/src/index.js";

export interface AgentWorkload {
  agentId: string;
  /** Tasks currently occupying the agent (ASSIGNED / RUNNING / WAITING_APPROVAL). */
  activeTasks: number;
  /** Assignable tasks already waiting on this agent. */
  queuedTasks: number;
  /** OPEN escalations addressed to this agent. */
  openEscalations: number;
  concurrency: ConcurrencyLevel;
  isActive: boolean;
}

export const CONCURRENCY_CAPACITY: Record<ConcurrencyLevel, number> = {
  LOW: 1,
  NORMAL: 3,
  HIGH: 6,
};

export function capacityFor(concurrency: ConcurrencyLevel): number {
  return CONCURRENCY_CAPACITY[concurrency] ?? CONCURRENCY_CAPACITY.NORMAL;
}

export function hasCapacity(workload: AgentWorkload): boolean {
  if (!workload.isActive) return false;
  return workload.activeTasks < capacityFor(workload.concurrency);
}

/**
 * Busy-ness in [0, 1+]. 0 = idle and eligible; >= 1 = at or over capacity.
 * Weights are deliberate: active work dominates, queued work is secondary
 * (a backlog is not the same as engagement), and each open escalation adds a
 * visible drag because an agent resolving blockers has less room to take more.
 */
export function loadScore(workload: AgentWorkload): number {
  const capacity = capacityFor(workload.concurrency);
  const active = workload.activeTasks / capacity;
  const queued = workload.queuedTasks / (capacity * 2);
  const escalations = workload.openEscalations * 0.1;
  return active + queued + escalations;
}

/** Ascending: least busy first. Stable on agentId so results are reproducible. */
export function compareWorkload(a: AgentWorkload, b: AgentWorkload): number {
  const byScore = loadScore(a) - loadScore(b);
  if (Math.abs(byScore) > 1e-9) return byScore;
  if (a.activeTasks !== b.activeTasks) return a.activeTasks - b.activeTasks;
  if (a.queuedTasks !== b.queuedTasks) return a.queuedTasks - b.queuedTasks;
  return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
}

/** Eligible = active, under capacity, and not excluded by the caller. */
export function isEligible(
  workload: AgentWorkload,
  excludeAgentIds: ReadonlySet<string> = new Set(),
): boolean {
  if (excludeAgentIds.has(workload.agentId)) return false;
  return hasCapacity(workload);
}
