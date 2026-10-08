/**
 * Performance tool -- an agent can read its own measured history. There is no
 * write path: performance comes from what actually happened, never from
 * self-assessment.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { validationError } from "../../../shared/src/index.js";
import { agentPerformance } from "../../../agents/src/index.js";
import type { ToolDefinition } from "../types.js";

export const agentPerformanceTool: ToolDefinition<{ agentId?: string; since?: string }> = {
  name: "agent.performance",
  description:
    "Your measured track record: task success rate, rework, review verdicts, execution " +
    "outcomes, AI cost. Computed from real history -- read-only, no self-grading.",
  inputSchema: z.object({
    agentId: z.string().optional().describe("Defaults to the calling agent"),
    since: z.string().optional().describe("ISO date lower bound"),
  }),
  requiredPermission: PERMISSIONS.AGENT_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = input.agentId ?? context.agentId;
    if (agentId === undefined) throw validationError("agent.performance requires an agent");
    const since = input.since !== undefined ? new Date(input.since) : undefined;
    const summary = await agentPerformance(context.db, agentId, { since });
    return { data: summary };
  },
};

export const performanceTools = [agentPerformanceTool];
