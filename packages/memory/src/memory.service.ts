/**
 * Memory service.
 *
 * Four kinds, deliberately distinct because they decay differently:
 *
 *   SHORT_TERM  - working context. High recency weight, expires in hours.
 *   LONG_TERM   - durable knowledge. Importance-dominant, effectively immortal.
 *   EPISODIC    - "what happened". Recency matters, tied to a task/conversation.
 *   FACT        - invariants and profile data. No decay; still retrievable.
 *
 * Retrieval is a deterministic weighted blend of importance and recency. This
 * is intentionally NOT vector search: for Phase 1's corpus size an exact
 * keyword + score query is both faster and more predictable, and it is
 * explainable in the UI ("why did the agent recall this?"). The interface is
 * already shaped for a hybrid retriever later - `MemoryRetriever` is the only
 * thing `retrieveMemories` needs to change - and `metadata.embeddingRef` is
 * reserved for that.
 */
import {
  MemorySourceSchema,
  MemoryKindSchema,
  newCorrelationId,
  validationError,
  type ActorRef,
  type MemoryKind,
} from "../../shared/src/index.js";
import { notFound } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { AgentMemory } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";

/** Half-life in hours for the recency component, per memory kind. */
const HALF_LIFE_HOURS: Record<MemoryKind, number> = {
  SHORT_TERM: 6,
  EPISODIC: 24 * 7,
  LONG_TERM: 24 * 365 * 5,
  FACT: Number.POSITIVE_INFINITY,
};

const DEFAULT_TTL_HOURS: Record<MemoryKind, number> = {
  SHORT_TERM: 12,
  EPISODIC: 24 * 30,
  LONG_TERM: 0,
  FACT: 0,
};

const IMPORTANCE_WEIGHT = 0.6;
const RECENCY_WEIGHT = 0.4;

export interface StoreMemoryInput {
  agentId: string;
  kind: string;
  content: string;
  importance?: number;
  source?: string;
  taskId?: string | null;
  conversationId?: string | null;
  eventId?: string | null;
  relatedAgentId?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
}

export interface MemoryContext {
  actor: ActorRef;
  correlationId?: string;
  worldId?: string;
}

export async function storeMemory(
  db: DbClient,
  input: StoreMemoryInput,
  ctx: MemoryContext,
): Promise<AgentMemory> {
  const kind = MemoryKindSchema.parse(input.kind);
  const source = MemorySourceSchema.parse(input.source ?? "SYSTEM");

  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw validationError("Memory content is required");
  }

  const importance = clampImportance(input.importance ?? 5);
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const now = new Date();

  const ttlHours = input.expiresAt !== undefined ? null : DEFAULT_TTL_HOURS[kind];
  const expiresAt =
    input.expiresAt !== undefined && input.expiresAt !== null
      ? input.expiresAt
      : ttlHours !== null && ttlHours > 0
        ? new Date(now.getTime() + ttlHours * 3_600_000)
        : null;

  const memory = await db.agentMemory.create({
    data: {
      agentId: input.agentId,
      kind,
      content: input.content.trim().slice(0, 8_000),
      importance,
      source,
      taskId: input.taskId ?? null,
      conversationId: input.conversationId ?? null,
      eventId: input.eventId ?? null,
      relatedAgentId: input.relatedAgentId ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      expiresAt,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_MEMORY_STORED,
    actor: ctx.actor,
    correlationId,
    targetType: "AgentMemory",
    targetId: memory.id,
    worldId: ctx.worldId,
    payload: { agentId: input.agentId, memoryId: memory.id, kind, importance },
  });

  return memory;
}

/** Recency component in [0,1]: 1.0 at creation, 0.5 after one half-life. */
export function recencyScore(kind: MemoryKind, createdAt: Date, now: Date): number {
  const halfLife = HALF_LIFE_HOURS[kind];
  if (!Number.isFinite(halfLife)) return 1;
  const ageHours = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);
  return Math.pow(0.5, ageHours / halfLife);
}

export function importanceScore(importance: number): number {
  return clampImportance(importance) / 10;
}

export function scoreMemory(memory: AgentMemory, now: Date): number {
  const kind = memory.kind as MemoryKind;
  const expired = memory.expiresAt !== null && memory.expiresAt.getTime() <= now.getTime();
  if (expired) return -1;
  return (
    IMPORTANCE_WEIGHT * importanceScore(memory.importance) +
    RECENCY_WEIGHT * recencyScore(kind, memory.createdAt, now)
  );
}

export interface RetrieveQuery {
  agentId: string;
  /** Case-insensitive substring match over memory content. */
  query?: string;
  kinds?: string[];
  /** Related agent whose memories are also considered (relationship recall). */
  relatedAgentId?: string;
  limit?: number;
  /** Exclude memories already linked to this conversation. */
  excludeConversationId?: string;
  /** Minimum normalised score. */
  minScore?: number;
  taskId?: string;
  now?: Date;
}

export interface RetrievedMemory {
  memory: AgentMemory;
  score: number;
}

/**
 * Ranked retrieval. Expired memories are filtered before scoring and are also
 * excluded by the `expiresAt` predicate, so a stale working note can never be
 * handed to the model.
 */
export async function retrieveMemories(
  db: DbClient,
  query: RetrieveQuery,
): Promise<RetrievedMemory[]> {
  const now = query.now ?? new Date();
  const limit = Math.min(query.limit ?? 10, 50);

  const agentIds =
    query.relatedAgentId !== undefined
      ? [query.agentId, query.relatedAgentId]
      : [query.agentId];

  // Multiple optional OR-groups have to be combined under AND; sibling `OR`
  // keys in one `where` object would silently overwrite each other.
  const andFilters: Record<string, unknown>[] = [];
  if (query.excludeConversationId !== undefined) {
    andFilters.push({
      OR: [
        { conversationId: null },
        { conversationId: { not: query.excludeConversationId } },
      ],
    });
  }
  if (query.taskId !== undefined) {
    andFilters.push({ OR: [{ taskId: null }, { taskId: query.taskId }] });
  }

  const memories = await db.agentMemory.findMany({
    where: {
      agentId: { in: agentIds },
      ...(query.kinds !== undefined ? { kind: { in: query.kinds } } : {}),
      ...(query.query !== undefined ? { content: { contains: query.query } } : {}),
      // Expired memories are excluded in the query, not filtered afterwards:
      // an expired note must never reach the model even transiently.
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(andFilters.length > 0 ? { AND: andFilters } : {}),
    },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  const scored: RetrievedMemory[] = [];
  for (const memory of memories) {
    const score = scoreMemory(memory, now);
    if (score < 0) continue;
    if (query.minScore !== undefined && score < query.minScore) continue;
    scored.push({ memory, score });
  }

  scored.sort((a, b) => b.score - a.score || b.memory.createdAt.getTime() - a.memory.createdAt.getTime());

  return scored.slice(0, limit);
}

/** Compact rendering of memories for an LLM prompt. */
export function formatMemoriesForPrompt(retrieved: RetrievedMemory[]): string {
  if (retrieved.length === 0) return "(no relevant memories)";
  return retrieved
    .map(({ memory }) => `- [${memory.kind} i${memory.importance}] ${memory.content}`)
    .join("\n");
}

export async function listMemories(
  db: DbClient,
  query: { agentId: string; kind?: string; limit?: number; skip?: number },
) {
  return db.agentMemory.findMany({
    where: {
      agentId: query.agentId,
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
    },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    skip: query.skip ?? 0,
    take: Math.min(query.limit ?? 50, 200),
  });
}

/**
 * Voluntary forgetting. Deletes rather than expires because an agent
 * "forgetting" is a deliberate act, distinct from a short-term note ageing out.
 */
export async function forgetMemory(
  db: DbClient,
  memoryId: string,
  ctx: MemoryContext,
): Promise<void> {
  const memory = await db.agentMemory.findUnique({ where: { id: memoryId } });
  if (memory === null) throw notFound("Memory", memoryId);

  await db.agentMemory.delete({ where: { id: memoryId } });
  await recordActivity(db, {
    actor: ctx.actor,
    action: "memory.forget",
    targetType: "AgentMemory",
    targetId: memoryId,
    correlationId: ctx.correlationId,
    metadata: { agentId: memory.agentId, kind: memory.kind },
  });
}

/** Housekeeping: removes aged short-term memories. Called by the world tick. */
export async function pruneExpiredMemories(db: DbClient, now = new Date()): Promise<number> {
  const result = await db.agentMemory.deleteMany({ where: { expiresAt: { lte: now } } });
  return result.count;
}

export async function getMemoryStats(db: DbClient, agentId: string) {
  const grouped = await db.agentMemory.groupBy({
    by: ["kind"],
    where: { agentId },
    _count: { _all: true },
    _avg: { importance: true },
  });
  return grouped.map((row) => ({
    kind: row.kind,
    count: row._count._all,
    averageImportance: row._avg.importance ?? 0,
  }));
}

function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(10, Math.round(value)));
}

export type { AgentMemory };
