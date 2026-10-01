/**
 * Report tools.
 *
 * Reports inform; they never interrupt. A report is authored (agent or
 * human), attributed to what it describes, and immutable once written.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { writeReport } from "../../../orchestration/src/index.js";
import type { ToolDefinition } from "../types.js";

export const reportSubmitTool: ToolDefinition<{
  kind: "PROGRESS" | "TASK" | "EXECUTION" | "REVIEW" | "ERROR";
  summary: string;
  payload?: Record<string, unknown>;
  taskId?: string;
  planId?: string;
  conversationId?: string;
}> = {
  name: "report.submit",
  description:
    "Write a structured report about a task, plan, or conversation: what was " +
    "done, what remains, blockers, and recommendations.",
  inputSchema: z.object({
    kind: z.enum(["PROGRESS", "TASK", "EXECUTION", "REVIEW", "ERROR"]),
    summary: z.string().min(1).max(2000),
    payload: z.record(z.string(), z.unknown()).optional(),
    taskId: z.string().optional(),
    planId: z.string().optional(),
    conversationId: z.string().optional(),
  }),
  requiredPermission: PERMISSIONS.REPORT_CREATE,
  risk: "LOW",
  async execute(context, input) {
    const report = await writeReport(
      context.db,
      {
        kind: input.kind,
        summary: input.summary,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
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
      data: { id: report.id, kind: report.kind, summary: report.summary },
      summary: `Report ${report.id} (${report.kind}) written`,
    };
  },
};

export const reportTools = [reportSubmitTool];
