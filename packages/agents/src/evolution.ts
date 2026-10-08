/**
 * Agent Evolution -- reputation derived from measured history, never asserted.
 *
 * `Agent.reputation` (0-100) is the only standing signal other systems may
 * read, and it moves only through this service: the same evidence the
 * Performance Center shows (task outcomes, review verdicts, execution
 * results) is rolled into a bounded delta and applied atomically. No model
 * call, no hidden weighting beyond the documented rates, and every change
 * emits AGENT_REPUTATION_CHANGED with from/to/reason so the evolution of an
 * agent's standing is fully auditable.
 */
import { newCorrelationId, validationError } from "../../shared/src/index.js";
import type { ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Agent } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { agentPerformance, type AgentPerformanceSummary } from "./performance.js";

export interface EvolutionContext {
  actor: ActorRef;
  correlationId?: string;
}

export interface ReputationResult {
  agentId: string;
  fromReputation: number;
  toReputation: number;
  delta: number;
  reason: string;
  performance: AgentPerformanceSummary;
}

/** Bounded, documented rates: evidence accumulates, never swings wildly. */
const MAX_TASK_DELTA = 10;
const MAX_REVIEW_DELTA = 6;
const MAX_EXECUTION_DELTA = 6;
const MIN_SAMPLE = 3; // below this there is not enough evidence to move standing

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Map a measured performance window to a reputation delta in [-1, 1].
 * Positive when the agent finishes and passes review; negative when it
 * fails, is rejected, or its executions time out. A thin sample yields 0:
 * an agent with one task must not be judged.
 */
function evidenceToDelta(p: AgentPerformanceSummary): number {
  const sampleWeight = Math.min(1, p.tasks.total / MIN_SAMPLE);
  let delta = 0;
  if (p.tasks.successRate !== null) {
    delta += ((p.tasks.successRate - 50) / 100) * MAX_TASK_DELTA;
  }
  if (p.reviews.approvalRate !== null) {
    delta += ((p.reviews.approvalRate - 50) / 100) * MAX_REVIEW_DELTA;
  }
  if (p.executions.successRate !== null) {
    delta += ((p.executions.successRate - 50) / 100) * MAX_EXECUTION_DELTA;
  }
  delta *= sampleWeight;
  return clamp(delta / (MAX_TASK_DELTA + MAX_REVIEW_DELTA + MAX_EXECUTION_DELTA), -1, 1);
}

/**
 * Recompute an agent's standing from its measured history and apply the
 * bounded movement. Returns the change even when nothing moved.
 */
export async function evolveReputation(
  db: DbClient,
  agentId: string,
  ctx: EvolutionContext,
  window?: { since?: Date },
): Promise<ReputationResult> {
  const correlationId = ctx.correlationId ?? newCorrelationId();

  const agent = await db.agent.findUnique({ where: { id: agentId } });
  if (agent === null) throw validationError(`Agent '${agentId}' does not exist`);

  const performance = await agentPerformance(db, agentId, window);
  const normalized = evidenceToDelta(performance);

  // Reputation lives in 0..100; one evolution step moves at most 5 points.
  const step = Math.round(normalized * 5);
  const toReputation = clamp(agent.reputation + step, 0, 100);

  if (toReputation === agent.reputation) {
    return {
      agentId,
      fromReputation: agent.reputation,
      toReputation,
      delta: 0,
      reason: "insufficient-or-neutral-evidence",
      performance,
    };
  }

  const reason =
    step > 0
      ? `measured-success (tasks=${performance.tasks.completed}/${performance.tasks.total}, reviews=${performance.reviews.approved}/${performance.reviews.total})`
      : `measured-failure (failed=${performance.tasks.failed + performance.tasks.cancelled}/${performance.tasks.total}, reviews-rejected=${performance.reviews.rejected})`;

  const updated = await db.agent.update({
    where: { id: agentId },
    data: { reputation: toReputation },
    select: { reputation: true },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_REPUTATION_CHANGED,
    actor: ctx.actor,
    correlationId,
    targetType: "Agent",
    targetId: agentId,
    payload: {
      agentId,
      fromReputation: agent.reputation,
      toReputation: updated.reputation,
      reason,
    },
  });

  return {
    agentId,
    fromReputation: agent.reputation,
    toReputation: updated.reputation,
    delta: updated.reputation - agent.reputation,
    reason,
    performance,
  };
}

/** Evolution pass over a whole company's active members (dashboard / heartbeat). */
export async function evolveCompanyReputations(
  db: DbClient,
  companyId: string,
  ctx: EvolutionContext,
): Promise<ReputationResult[]> {
  const members = await db.companyMember.findMany({
    where: { companyId, isActive: true },
    select: { agentId: true },
  });
  const results: ReputationResult[] = [];
  for (const member of members) {
    results.push(await evolveReputation(db, member.agentId, ctx));
  }
  return results;
}

export type { Agent };
