/**
 * Agent relationships -- the social graph as measured evidence, never as
 * authority.
 *
 * Every edge in `AgentRelationship` is derived from interaction history:
 * conversations, shared tasks, co-location during the same tick window. The
 * scores (affinity -100..100, trust 0..100) influence SOCIAL behaviour only:
 * whom to talk to, whom to ask for help. They never widen permissions -- the
 * ToolExecutor checks the caller's RoleProfile grants, not its friends.
 */
import { newCorrelationId, validationError } from "../../shared/src/index.js";
import type { ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { AgentRelationship } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";

export interface RelationshipContext {
  actor: ActorRef;
  correlationId?: string;
}

/** One observed interaction between two agents. */
export interface InteractionInput {
  sourceAgentId: string;
  targetAgentId: string;
  /** CONVERSATION | COLLABORATION | CO_LOCATION | OUTCOME */
  kind: "CONVERSATION" | "COLLABORATION" | "CO_LOCATION" | "OUTCOME";
  /** Direction of the outcome signal: positive succeeded, negative failed. */
  outcome?: "SUCCESS" | "FAILURE";
  weight?: number;
}

const CLAMP = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Score deltas per interaction kind. Deliberately small: evidence accumulates. */
const DELTAS: Record<InteractionInput["kind"], { affinity: number; trust: number }> = {
  CONVERSATION: { affinity: 2, trust: 1 },
  COLLABORATION: { affinity: 4, trust: 3 },
  CO_LOCATION: { affinity: 1, trust: 0 },
  OUTCOME: { affinity: 0, trust: 0 }, // set from outcome below
};

export async function recordInteraction(
  db: DbClient,
  input: InteractionInput,
  ctx: RelationshipContext,
): Promise<AgentRelationship> {
  if (input.sourceAgentId === input.targetAgentId) {
    throw validationError("An agent cannot have a relationship with itself");
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();

  // Verify both agents exist; a relationship to a ghost agent is a bug, not data.
  for (const agentId of [input.sourceAgentId, input.targetAgentId]) {
    const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
    if (agent === null) throw validationError(`Agent '${agentId}' does not exist`);
  }

  const existing = await db.agentRelationship.findUnique({
    where: { agentId_targetAgentId: { agentId: input.sourceAgentId, targetAgentId: input.targetAgentId } },
  });

  let deltaAffinity: number;
  let deltaTrust: number;
  if (input.kind === "OUTCOME") {
    deltaAffinity = input.outcome === "SUCCESS" ? 3 : -4;
    deltaTrust = input.outcome === "SUCCESS" ? 4 : -6;
  } else {
    deltaAffinity = DELTAS[input.kind].affinity;
    deltaTrust = DELTAS[input.kind].trust;
  }
  const weight = input.weight === undefined ? 1 : CLAMP(Math.floor(input.weight), 1, 5);
  deltaAffinity *= weight;
  deltaTrust *= weight;

  const edge = existing
    ? await db.agentRelationship.update({
        where: { id: existing.id },
        data: {
          affinity: CLAMP(existing.affinity + deltaAffinity, -100, 100),
          trust: CLAMP(existing.trust + deltaTrust, 0, 100),
          interactionCount: { increment: 1 },
          lastInteractionAt: new Date(),
        },
      })
    : await db.agentRelationship.create({
        data: {
          agentId: input.sourceAgentId,
          targetAgentId: input.targetAgentId,
          affinity: CLAMP(deltaAffinity, -100, 100),
          trust: CLAMP(50 + deltaTrust, 0, 100),
          interactionCount: 1,
          lastInteractionAt: new Date(),
        },
      });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.RELATIONSHIP_CHANGED,
    actor: ctx.actor,
    correlationId,
    targetType: "AgentRelationship",
    targetId: edge.id,
    payload: {
      sourceAgentId: input.sourceAgentId,
      targetAgentId: input.targetAgentId,
      kind: input.kind,
      outcome: input.outcome ?? null,
      affinity: edge.affinity,
      trust: edge.trust,
      interactionCount: edge.interactionCount,
    },
  });
  await recordActivity(db, {
    action: "relationship.record",
    actor: ctx.actor,
    targetType: "AgentRelationship",
    targetId: edge.id,
    result: "OK",
    correlationId,
    metadata: { kind: input.kind, outcome: input.outcome ?? null },
  }).catch(() => undefined);

  return edge;
}

/** Outgoing edges for an agent, strongest affinity first. */
export async function listRelationships(db: DbClient, agentId: string): Promise<AgentRelationship[]> {
  return db.agentRelationship.findMany({
    where: { agentId },
    orderBy: [{ affinity: "desc" }, { interactionCount: "desc" }],
  });
}

/** The single edge between two agents, or null when they never interacted. */
export async function getRelationship(
  db: DbClient,
  sourceAgentId: string,
  targetAgentId: string,
): Promise<AgentRelationship | null> {
  return db.agentRelationship.findUnique({
    where: { agentId_targetAgentId: { agentId: sourceAgentId, targetAgentId } },
  });
}

/**
 * Social lookup: the agents this agent interacts with most positively.
 * Read-only; the result feeds social decisions (whom to consult), nothing else.
 */
export async function closestPeers(db: DbClient, agentId: string, limit = 5): Promise<AgentRelationship[]> {
  return db.agentRelationship.findMany({
    where: { agentId, affinity: { gt: 0 } },
    orderBy: [{ affinity: "desc" }, { interactionCount: "desc" }],
    take: Math.min(Math.max(1, limit), 20),
  });
}
