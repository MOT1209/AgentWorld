/**
 * Communication tools.
 *
 * `message.send` addresses recipients by ROLE, not by name. That is what allows
 * an agent to say "EXECUTOR, please take this" and have it reach whoever holds
 * that role today, including after a human has replaced the agent via the Agent
 * Factory.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import {
  createConversation,
  getRecentMessages,
  parseRecipientSpec,
  resolveRecipient,
  sendMessage,
} from "../../../agents/src/index.js";
import { requireTask } from "../../../tasks/src/index.js";
import { validationError } from "../../../shared/src/index.js";
import type { Conversation } from "../../../database/src/types.js";
import type { ToolDefinition, ToolExecutionContext } from "../types.js";

export const messageSendTool: ToolDefinition<{
  to: string;
  content: string;
  kind?: string;
  taskId?: string;
}> = {
  name: "message.send",
  description:
    "Send a message to another agent or to the human owner. Address recipients by ROLE KEY " +
    "(for example 'EXECUTOR' or 'PLANNER') rather than by personal name, so the message reaches " +
    "whoever currently holds that role. Use kind=PLAN when handing over a plan, kind=REPORT when " +
    "reporting a completed outcome, kind=REQUEST when asking for something, and kind=QUESTION when " +
    "you need clarification.",
  inputSchema: z.object({
    to: z
      .string()
      .max(80)
      .describe("Role key (PLANNER, EXECUTOR, REVIEWER, ANALYST), the string 'COMPANY', or an agent id"),
    content: z.string().min(1).max(8_000).describe("The message body"),
    kind: z
      .enum(["MESSAGE", "PLAN", "REPORT", "REQUEST", "QUESTION", "APPROVAL_REQUEST"])
      .default("MESSAGE"),
    taskId: z.string().optional().describe("Related task id, if any"),
  }),
  requiredPermission: PERMISSIONS.MESSAGE_SEND,
  risk: "LOW",
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("message.send requires an agent sender");

    // A fabricated task id would make the message permanently untraceable.
    if (input.taskId !== undefined) await requireTask(context.db, input.taskId);

    const spec = parseRecipientSpec(input.to, context.companyId ?? null);
    const recipients = await resolveRecipient(context.db, spec);

    // Never message yourself: it adds no information and clutters the transcript.
    const targets = recipients.filter((agent) => agent.id !== agentId);
    if (targets.length === 0) {
      throw validationError(`No recipient other than yourself matches '${input.to}'`);
    }

    const conversations: Array<{ conversationId: string; recipientAgentId: string }> = [];

    for (const recipient of targets) {
      const conversation = await ensureThread(context, recipient.id);
      await sendMessage(
        context.db,
        {
          conversationId: conversation.id,
          content: input.content,
          senderType: "AGENT",
          senderAgentId: agentId,
          kind: input.kind,
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          correlationId: context.correlationId,
        },
        {
          actor: context.actor,
          correlationId: context.correlationId,
          ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
        },
      );
      conversations.push({ conversationId: conversation.id, recipientAgentId: recipient.id });
    }

    return {
      data: {
        deliveredTo: targets.map((agent) => ({
          agentId: agent.id,
          name: agent.name,
          roleKey: agent.roleKey,
        })),
        conversations,
      },
      summary: `Sent ${String(input.kind).toLowerCase()} to ${targets.map((agent) => agent.name).join(", ")}`,
    };
  },
};

/** Finds the existing thread with this agent, or opens one. */
async function ensureThread(
  context: ToolExecutionContext,
  recipientAgentId: string,
): Promise<Conversation> {
  const agentId = context.agentId;
  if (agentId === undefined) throw validationError("Thread lookup requires an agent sender");

  const existing = await context.db.conversation.findFirst({
    where: {
      kind: "AGENT_AGENT",
      participants: { some: { agentId: recipientAgentId } },
      AND: { participants: { some: { agentId } } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (existing !== null) return existing;

  return createConversation(
    context.db,
    {
      kind: "AGENT_AGENT",
      title: `Agent thread ${recipientAgentId.slice(0, 8)}`,
      ...(context.companyId !== undefined ? { companyId: context.companyId } : {}),
      participantAgentIds: [recipientAgentId, agentId],
    },
    { actor: context.actor, correlationId: context.correlationId },
  );
}

export const messageReadTool: ToolDefinition<{ conversationId?: string; limit?: number }> = {
  name: "message.read",
  description:
    "Read recent messages from a conversation. Supply a conversationId to read one thread, " +
    "or omit it to see the most recent messages in your conversations.",
  inputSchema: z.object({
    conversationId: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  requiredPermission: PERMISSIONS.MESSAGE_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("message.read requires an agent");

    const conversations = await context.db.conversation.findMany({
      where: { participants: { some: { agentId } } },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });

    const targetId =
      input.conversationId ?? conversations[0]?.id;
    if (targetId === undefined) {
      return { data: { messages: [] }, summary: "No conversations available" };
    }

    const messages = await getRecentMessages(context.db, targetId, input.limit);
    return {
      data: {
        conversationId: targetId,
        messages: messages.map((message) => ({
          id: message.id,
          senderType: message.senderType,
          senderAgentId: message.senderAgentId,
          kind: message.kind,
          content: message.content,
          createdAt: message.createdAt,
        })),
      },
      summary: `Read ${messages.length} message(s) from ${targetId.slice(0, 8)}`,
    };
  },
};

export const communicationTools = [messageSendTool, messageReadTool];
