/**
 * Escalation tools.
 *
 * `agent.escalate` is the pressure valve: a blocked or out-of-depth agent
 * raises a structured escalation instead of guessing. Without an explicit
 * target the service routes via the role hierarchy; an unroutable escalation
 * means "a human must look at this".
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { raiseEscalation } from "../../../orchestration/src/index.js";
import type { ToolDefinition } from "../types.js";

export const escalateTool: ToolDefinition<{
  category:
    | "BLOCKED"
    | "TOOL_UNAVAILABLE"
    | "TASK_IMPOSSIBLE"
    | "APPROVAL_REQUIRED"
    | "REPEATED_FAILURE"
    | "PERMISSION_DENIED"
    | "MISSING_INFORMATION";
  detail: string;
  taskId?: string;
  planId?: string;
  toAgentId?: string;
  toUserId?: string;
  fromAgentId?: string;
}> = {
  name: "agent.escalate",
  description:
    "Raise a structured escalation when blocked, under-equipped, or out of " +
    "depth. Omit the target to route via the role hierarchy.",
  inputSchema: z.object({
    category: z.enum([
      "BLOCKED",
      "TOOL_UNAVAILABLE",
      "TASK_IMPOSSIBLE",
      "APPROVAL_REQUIRED",
      "REPEATED_FAILURE",
      "PERMISSION_DENIED",
      "MISSING_INFORMATION",
    ]),
    detail: z.string().min(10).max(5000),
    taskId: z.string().optional(),
    planId: z.string().optional(),
    toAgentId: z.string().optional(),
    toUserId: z.string().optional(),
    fromAgentId: z
      .string()
      .optional()
      .describe("Only for non-agent callers; agents always escalate as themselves."),
  }),
  requiredPermission: PERMISSIONS.ESCALATE,
  risk: "MEDIUM",
  async execute(context, input) {
    const fromAgentId = context.agentId ?? input.fromAgentId;
    if (fromAgentId === undefined) {
      throw new Error("agent.escalate requires an agent caller or an explicit fromAgentId");
    }
    const escalation = await raiseEscalation(
      context.db,
      {
        fromAgentId,
        category: input.category,
        detail: input.detail,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        ...(input.toAgentId !== undefined ? { toAgentId: input.toAgentId } : {}),
        ...(input.toUserId !== undefined ? { toUserId: input.toUserId } : {}),
      },
      {
        actor: context.actor,
        correlationId: context.correlationId,
        permissions: context.permissions,
        ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
        ...(context.actor.actorType === "USER" && context.actor.actorId !== undefined
          ? { userId: context.actor.actorId }
          : {}),
        ...(context.companyId !== undefined ? { companyId: context.companyId } : {}),
        ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
      },
    );
    return {
      data: {
        id: escalation.id,
        category: escalation.category,
        status: escalation.status,
        toAgentId: escalation.toAgentId,
      },
      summary: `Escalation ${escalation.id} (${escalation.category}) raised`,
    };
  },
};

export const escalationTools = [escalateTool];
