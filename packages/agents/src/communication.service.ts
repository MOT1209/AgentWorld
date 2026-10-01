/**
 * Internal communication.
 *
 * Agents talk to each other and to humans through persisted Conversations and
 * Messages. Messages are never deleted - the transcript is the record of who
 * decided what, and it is what the dashboard replays to show a human how a
 * request turned into work.
 *
 * Recipients are addressed by ROLE, not by name. `message.send({to: "EXECUTOR"})`
 * resolves to whichever agent currently holds that role in the company, which
 * is what keeps the system working after a human swaps an agent out via the
 * Agent Factory.
 */
import {
  ConversationKindSchema,
  MessageKindSchema,
  newCorrelationId,
  toJson,
  validationError,
  type ActorRef,
} from "../../shared/src/index.js";
import { notFound, validationError as invalid } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Agent, Conversation, Message } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";

export type RecipientSpec =
  | { kind: "AGENT"; agentId: string }
  | { kind: "ROLE"; roleKey: string }
  | { kind: "COMPANY"; companyId: string };

export interface CommunicationContext {
  actor: ActorRef;
  correlationId?: string;
  userId?: string;
  worldId?: string;
}

export interface CreateConversationInput {
  kind: string;
  title: string;
  companyId?: string | null;
  createdByUserId?: string | null;
  participantAgentIds?: string[];
}

export async function createConversation(
  db: DbClient,
  input: CreateConversationInput,
  ctx: CommunicationContext,
): Promise<Conversation> {
  const kind = ConversationKindSchema.parse(input.kind);
  const correlationId = ctx.correlationId ?? newCorrelationId();

  const conversation = await db.conversation.create({
    data: {
      kind,
      title: input.title.trim().slice(0, 200),
      companyId: input.companyId ?? null,
      createdByUserId: input.createdByUserId ?? ctx.userId ?? null,
      participants:
        input.participantAgentIds !== undefined && input.participantAgentIds.length > 0
          ? { create: input.participantAgentIds.map((agentId) => ({ agentId })) }
          : undefined,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.CONVERSATION_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "Conversation",
    targetId: conversation.id,
    companyId: conversation.companyId ?? undefined,
    payload: { conversationId: conversation.id, kind, title: conversation.title },
  });

  return conversation;
}

/** Finds the direct human<->agent thread, creating it on first use. */
export async function findOrCreateDirectConversation(
  db: DbClient,
  input: { userId: string; agentId: string; companyId?: string | null },
  ctx: CommunicationContext,
): Promise<Conversation> {
  const existing = await db.conversation.findFirst({
    where: {
      kind: "HUMAN_AGENT",
      createdByUserId: input.userId,
      participants: { some: { agentId: input.agentId } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (existing !== null) return existing;

  const agent = await db.agent.findUnique({ where: { id: input.agentId } });
  if (agent === null) throw notFound("Agent", input.agentId);

  return createConversation(
    db,
    {
      kind: "HUMAN_AGENT",
      title: `${agent.name} <-> Owner`,
      companyId: input.companyId ?? agent.currentCompanyId,
      createdByUserId: input.userId,
      participantAgentIds: [input.agentId],
    },
    ctx,
  );
}

export interface SendMessageInput {
  conversationId: string;
  content: string;
  senderType: "HUMAN" | "AGENT" | "SYSTEM";
  senderUserId?: string | null;
  senderAgentId?: string | null;
  kind?: string;
  taskId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export interface SendMessageResult {
  message: Message;
  /** Agent woken by this message, if any. Drives the agent-to-agent loop. */
  notifyAgentId: string | null;
}

export async function sendMessage(
  db: DbClient,
  input: SendMessageInput,
  ctx: CommunicationContext,
): Promise<SendMessageResult> {
  const correlationId = input.correlationId ?? ctx.correlationId ?? newCorrelationId();
  const content = input.content?.trim();
  if (content === undefined || content.length === 0) {
    throw invalid("Message content cannot be empty");
  }

  const conversation = await db.conversation.findUnique({
    where: { id: input.conversationId },
    include: { participants: { select: { agentId: true } } },
  });
  if (conversation === null) throw notFound("Conversation", input.conversationId);
  if (conversation.isClosed) {
    throw invalid("Conversation is closed");
  }

  const senderType = input.senderType;
  if (senderType === "AGENT" && (input.senderAgentId === undefined || input.senderAgentId === null)) {
    throw invalid("An agent message requires senderAgentId");
  }
  if (senderType === "HUMAN" && (input.senderUserId === undefined || input.senderUserId === null)) {
    throw invalid("A human message requires senderUserId");
  }

  const kind = MessageKindSchema.parse(input.kind ?? "MESSAGE");

  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      senderType,
      senderUserId: input.senderUserId ?? null,
      senderAgentId: input.senderAgentId ?? null,
      kind,
      content: content.slice(0, 20_000),
      taskId: input.taskId ?? null,
      correlationId,
      metadata: toJson(input.metadata ?? {}),
    },
  });

  await db.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });

  // Mark the sender as having read their own message.
  if (senderType === "AGENT" && input.senderAgentId !== null && input.senderAgentId !== undefined) {
    await db.conversationParticipant.updateMany({
      where: { conversationId: conversation.id, agentId: input.senderAgentId },
      data: { lastReadAt: new Date() },
    });
  }

  // Wake a single agent recipient, if the sender is not the only participant.
  const notifyAgentId =
    senderType === "HUMAN" && conversation.participants.length === 1
      ? (conversation.participants[0]?.agentId ?? null)
      : null;

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.MESSAGE_SENT,
    actor: ctx.actor,
    correlationId,
    targetType: "Message",
    targetId: message.id,
    companyId: conversation.companyId ?? undefined,
    worldId: ctx.worldId,
    payload: {
      messageId: message.id,
      conversationId: conversation.id,
      senderType,
      senderId: input.senderAgentId ?? input.senderUserId ?? null,
      kind,
      notifyAgentId,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "message.send",
    targetType: "Conversation",
    targetId: conversation.id,
    correlationId,
    userId: input.senderUserId ?? ctx.userId,
    metadata: { messageId: message.id, kind, senderType },
  });

  return { message, notifyAgentId };
}

/**
 * Resolves a recipient spec to a concrete agent.
 *
 * Role addressing is the reason agents are addressed by ROLE: replacing an
 * agent through the Agent Factory does not require rewriting any caller's
 * addressing logic.
 */
export async function resolveRecipient(
  db: DbClient,
  spec: RecipientSpec,
): Promise<Agent[]> {
  switch (spec.kind) {
    case "AGENT": {
      const agent = await db.agent.findUnique({ where: { id: spec.agentId } });
      if (agent === null) throw notFound("Agent", spec.agentId);
      return [agent];
    }
    case "ROLE": {
      const agents = await db.agent.findMany({
        where: { roleKey: spec.roleKey, isActive: true },
        orderBy: { createdAt: "asc" },
      });
      if (agents.length === 0) {
        throw notFound(`Agent holding role '${spec.roleKey}'`);
      }
      return agents;
    }
    case "COMPANY": {
      const agents = await db.agent.findMany({
        where: { currentCompanyId: spec.companyId, isActive: true },
        orderBy: { createdAt: "asc" },
      });
      if (agents.length === 0) {
        throw notFound(`Agent in company '${spec.companyId}'`);
      }
      return agents;
    }
  }
}

export function parseRecipientSpec(
  to: string,
  companyId?: string | null,
): RecipientSpec {
  const value = to.trim();
  if (value === "") throw validationError("Recipient must not be empty");

  if (value === "ALL" || value === "COMPANY") {
    if (companyId === undefined || companyId === null) {
      throw validationError("A company context is required to address the whole company");
    }
    return { kind: "COMPANY", companyId };
  }

  // A cuid or any id-looking token is an explicit agent reference.
  if (/^c[a-z0-9]{20,}$/i.test(value)) return { kind: "AGENT", agentId: value };

  // Anything else is a role key.
  return { kind: "ROLE", roleKey: value.toUpperCase() };
}

export async function listConversations(
  db: DbClient,
  query: {
    kind?: string;
    companyId?: string;
    agentId?: string;
    userId?: string;
    skip?: number;
    take?: number;
  } = {},
): Promise<Conversation[]> {
  return db.conversation.findMany({
    where: {
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.companyId !== undefined ? { companyId: query.companyId } : {}),
      ...(query.userId !== undefined ? { createdByUserId: query.userId } : {}),
      ...(query.agentId !== undefined ? { participants: { some: { agentId: query.agentId } } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    skip: query.skip ?? 0,
    take: Math.min(query.take ?? 50, 200),
  });
}

export interface ConversationDetail {
  conversation: Conversation;
  participants: Array<{ agentId: string; name: string; title: string; roleKey: string; state: string | null }>;
  messages: Message[];
}

export async function getConversationDetail(
  db: DbClient,
  conversationId: string,
  options: { messageLimit?: number } = {},
): Promise<ConversationDetail> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    include: {
      participants: {
        include: {
          agent: {
            select: {
              id: true,
              name: true,
              title: true,
              roleKey: true,
              state: { select: { state: true } },
            },
          },
        },
      },
    },
  });
  if (conversation === null) throw notFound("Conversation", conversationId);

  const messages = await db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    take: Math.min(options.messageLimit ?? 500, 2000),
  });

  return {
    conversation,
    participants: conversation.participants.map((participant) => ({
      agentId: participant.agent.id,
      name: participant.agent.name,
      title: participant.agent.title,
      roleKey: participant.agent.roleKey,
      state: participant.agent.state?.state ?? null,
    })),
    messages,
  };
}

/** Agents that have unread messages in a conversation. */
export async function getUnreadCounts(
  db: DbClient,
  agentId: string,
): Promise<Record<string, number>> {
  const participants = await db.conversationParticipant.findMany({
    where: { agentId },
    select: { conversationId: true, lastReadAt: true },
  });
  if (participants.length === 0) return {};

  const counts: Record<string, number> = {};
  for (const participant of participants) {
    const since = participant.lastReadAt ?? new Date(0);
    const count = await db.message.count({
      where: {
        conversationId: participant.conversationId,
        createdAt: { gt: since },
        NOT: { senderAgentId: agentId },
      },
    });
    if (count > 0) counts[participant.conversationId] = count;
  }
  return counts;
}

export async function markConversationRead(
  db: DbClient,
  conversationId: string,
  agentId: string,
): Promise<void> {
  await db.conversationParticipant.updateMany({
    where: { conversationId, agentId },
    data: { lastReadAt: new Date() },
  });
}

export async function closeConversation(
  db: DbClient,
  conversationId: string,
): Promise<Conversation> {
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  if (conversation === null) throw notFound("Conversation", conversationId);
  return db.conversation.update({ where: { id: conversationId }, data: { isClosed: true } });
}

/** Most recent messages, oldest-first, trimmed to a token-ish budget. */
export async function getRecentMessages(
  db: DbClient,
  conversationId: string,
  limit = 20,
): Promise<Message[]> {
  const rows = await db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse();
}
