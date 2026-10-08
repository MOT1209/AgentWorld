/**
 * Relationship tools -- read the social graph and record observable
 * interactions. Scores influence social choices only; they never grant
 * permissions. `relationship.observe` accepts only evidence kinds: there is
 * no "grant trust" action, because trust is earned through recorded outcomes,
 * not asserted.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { validationError } from "../../../shared/src/index.js";
import {
  closestPeers,
  getRelationship,
  listRelationships,
  recordInteraction,
} from "../../../agents/src/index.js";
import type { ToolDefinition } from "../types.js";

export const relationshipListTool: ToolDefinition<{ agentId?: string }> = {
  name: "relationship.list",
  description:
    "List your (or another agent's) relationship edges, strongest first. " +
    "Affinity is -100..100 and trust 0..100; both are measured from interaction history, not asserted.",
  inputSchema: z.object({
    agentId: z.string().optional().describe("Defaults to the calling agent"),
  }),
  requiredPermission: PERMISSIONS.AGENT_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = input.agentId ?? context.agentId;
    if (agentId === undefined) throw validationError("relationship.list requires an agent");
    const edges = await listRelationships(context.db, agentId);
    return { data: { agentId, count: edges.length, relationships: edges } };
  },
};

export const relationshipPeersTool: ToolDefinition<{ limit?: number }> = {
  name: "relationship.peers",
  description:
    "Your closest positive peers -- whom you interacted with most successfully. " +
    "Use this to decide whom to consult; it does not confer any authority.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(20).default(5),
  }),
  requiredPermission: PERMISSIONS.AGENT_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("relationship.peers requires an agent");
    const peers = await closestPeers(context.db, agentId, input.limit);
    return { data: { agentId, peers } };
  },
};

export const relationshipGetTool: ToolDefinition<{ targetAgentId: string; agentId?: string }> = {
  name: "relationship.get",
  description: "The measured relationship between two agents, or null when they never interacted.",
  inputSchema: z.object({
    agentId: z.string().optional(),
    targetAgentId: z.string().min(1),
  }),
  requiredPermission: PERMISSIONS.AGENT_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = input.agentId ?? context.agentId;
    if (agentId === undefined) throw validationError("relationship.get requires an agent");
    const edge = await getRelationship(context.db, agentId, input.targetAgentId);
    return { data: { agentId, targetAgentId: input.targetAgentId, relationship: edge } };
  },
};

export const relationshipObserveTool: ToolDefinition<{
  targetAgentId: string;
  kind: "CONVERSATION" | "COLLABORATION" | "CO_LOCATION" | "OUTCOME";
  outcome?: "SUCCESS" | "FAILURE";
  weight?: number;
}> = {
  name: "relationship.observe",
  description:
    "Record an observed interaction with another agent. Kinds: CONVERSATION (you talked), " +
    "COLLABORATION (you worked together), CO_LOCATION (shared a location), OUTCOME (a joint " +
    "task succeeded or failed). Evidence only: fabricated observations are audit-visible and " +
    "scores move slowly by design.",
  inputSchema: z.object({
    targetAgentId: z.string().min(1),
    kind: z.enum(["CONVERSATION", "COLLABORATION", "CO_LOCATION", "OUTCOME"]),
    outcome: z.enum(["SUCCESS", "FAILURE"]).optional(),
    weight: z.number().int().min(1).max(5).optional().describe("1 normal, 5 major"),
  }),
  requiredPermission: PERMISSIONS.AGENT_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("relationship.observe requires an agent");
    const edge = await recordInteraction(
      context.db,
      {
        sourceAgentId: agentId,
        targetAgentId: input.targetAgentId,
        kind: input.kind,
        outcome: input.outcome,
        weight: input.weight,
      },
      { actor: context.actor, correlationId: context.correlationId },
    );
    return {
      data: { relationship: edge },
      summary: `Recorded ${input.kind} with ${input.targetAgentId}: affinity ${edge.affinity}, trust ${edge.trust}`,
    };
  },
};

export const relationshipTools = [
  relationshipListTool,
  relationshipPeersTool,
  relationshipGetTool,
  relationshipObserveTool,
];
