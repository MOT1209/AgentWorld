/**
 * Session tools.
 *
 * `session.start` opens an observability record for a bounded execution run;
 * `session.status` reads it back. Agents see their own sessions only. The
 * run itself still goes through the agent runtime; these tools are the
 * bookkeeping around it.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { getSession, listSessions, startSession } from "../../../runtime/src/index.js";
import type { ToolDefinition } from "../types.js";

export const sessionStartTool: ToolDefinition<{
  agentId?: string;
  providerId?: string;
  model?: string;
  taskId?: string;
  trigger?: string;
}> = {
  name: "session.start",
  description:
    "Open a session record for a bounded execution run. Returns the session " +
    "id to tag tool calls and the final result with.",
  inputSchema: z.object({
    agentId: z
      .string()
      .optional()
      .describe("Defaults to yourself. Humans may open for any agent."),
    providerId: z.string().optional(),
    model: z.string().optional(),
    taskId: z.string().optional(),
    trigger: z.enum(["CHAT", "TASK_ASSIGNED", "SCHEDULED", "MANUAL"]).default("MANUAL"),
  }),
  requiredPermission: PERMISSIONS.SESSION_START,
  risk: "LOW",
  async execute(context, input) {
    const agentId = input.agentId ?? context.agentId;
    if (agentId === undefined) {
      throw new Error("session.start requires an agent");
    }
    const session = await startSession(
      context.db,
      {
        agentId,
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        trigger: input.trigger,
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
      data: { id: session.id, agentId: session.agentId, status: session.status, providerId: session.providerId },
      summary: `Session ${session.id} opened for agent ${session.agentId}`,
    };
  },
};

export const sessionStatusTool: ToolDefinition<{ sessionId?: string; limit?: number }> = {
  name: "session.status",
  description: "Read one of your sessions, or list your recent sessions.",
  inputSchema: z.object({
    sessionId: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  requiredPermission: PERMISSIONS.SESSION_READ,
  risk: "LOW",
  async execute(context, input) {
    if (input.sessionId !== undefined) {
      const session = await getSession(context.db, input.sessionId);
      if (context.agentId !== undefined && session.agentId !== context.agentId) {
        throw new Error("Agents may only read their own sessions");
      }
      return {
        data: {
          id: session.id,
          agentId: session.agentId,
          status: session.status,
          providerId: session.providerId,
          model: session.model,
          taskId: session.taskId,
          result: session.result,
          error: session.error,
        },
        summary: `Session ${session.id} is ${session.status}`,
      };
    }
    const sessions = await listSessions(context.db, {
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      take: input.limit,
    });
    return {
      data: {
        sessions: sessions.map((session) => ({
          id: session.id,
          agentId: session.agentId,
          status: session.status,
          taskId: session.taskId,
        })),
      },
      summary: `${sessions.length} session(s)`,
    };
  },
};

export const sessionTools = [sessionStartTool, sessionStatusTool];
