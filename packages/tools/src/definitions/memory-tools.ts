/**
 * Memory tools: store and search.
 *
 * `memory.store` is the agent's only way to remember anything between runs, and
 * `memory.search` its only way to recall it. Both are scoped to the calling
 * agent: there is no argument that lets an agent read another agent's memories,
 * because the tool never accepts an agent id.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import {
  forgetMemory,
  listMemories,
  retrieveMemories,
  storeMemory,
} from "../../../memory/src/index.js";
import { validationError } from "../../../shared/src/index.js";
import type { ToolDefinition } from "../types.js";

export const memoryStoreTool: ToolDefinition<{
  kind: "SHORT_TERM" | "LONG_TERM" | "EPISODIC" | "FACT";
  content: string;
  importance?: number;
  taskId?: string;
}> = {
  name: "memory.store",
  description:
    "Record something worth remembering. Choose the kind deliberately: " +
    "SHORT_TERM for an obligation you are waiting on, LONG_TERM for durable knowledge, " +
    "EPISODIC for something that happened, FACT for an invariant or a conclusion. " +
    "Importance is 1-10; use 9 only for things that would be costly to rediscover. " +
    "Do not store secrets, credentials, or anything the owner would not want retained.",
  inputSchema: z.object({
    kind: z
      .enum(["SHORT_TERM", "LONG_TERM", "EPISODIC", "FACT"])
      .describe("Which memory store this belongs in"),
    content: z.string().min(1).max(4_000).describe("The memory itself, self-contained"),
    importance: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("1 trivial, 5 notable, 9 costly to rediscover"),
    taskId: z.string().optional().describe("Related task id"),
  }),
  requiredPermission: PERMISSIONS.MEMORY_WRITE,
  risk: "LOW",
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("memory.store requires an agent");

    const memory = await storeMemory(
      context.db,
      {
        agentId,
        kind: input.kind,
        content: input.content,
        importance: input.importance,
        source: "AGENT",
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      },
      {
        actor: context.actor,
        correlationId: context.correlationId,
        ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
      },
    );

    return {
      data: { memoryId: memory.id, kind: memory.kind, importance: memory.importance },
      summary: `Stored ${memory.kind.toLowerCase()} memory`,
    };
  },
};

export const memorySearchTool: ToolDefinition<{ query?: string; kind?: string; limit?: number }> = {
  name: "memory.search",
  description:
    "Recall your own memories, ranked by importance and recency. Omit the query to see your most " +
    "salient memories. Filter by kind to recall, for example, only facts.",
  inputSchema: z.object({
    query: z.string().max(200).optional().describe("Substring to match against memory content"),
    kind: z
      .enum(["SHORT_TERM", "LONG_TERM", "EPISODIC", "FACT"])
      .optional()
      .describe("Restrict to one memory kind"),
    limit: z.number().int().min(1).max(25).default(8),
  }),
  requiredPermission: PERMISSIONS.MEMORY_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("memory.search requires an agent");

    if (input.query !== undefined || input.kind === undefined) {
      const retrieved = await retrieveMemories(context.db, {
        agentId,
        limit: input.limit,
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.kind !== undefined ? { kinds: [input.kind] } : {}),
      });
      return {
        data: {
          memories: retrieved.map(({ memory, score }) => ({
            id: memory.id,
            kind: memory.kind,
            content: memory.content,
            importance: memory.importance,
            score: Number(score.toFixed(3)),
          })),
        },
        summary: `Recalled ${retrieved.length} memory/memories`,
      };
    }

    const memories = await listMemories(context.db, {
      agentId,
      kind: input.kind,
      limit: input.limit,
    });
    return {
      data: {
        memories: memories.map((memory) => ({
          id: memory.id,
          kind: memory.kind,
          content: memory.content,
          importance: memory.importance,
        })),
      },
      summary: `Recalled ${memories.length} memory/memories`,
    };
  },
};

export const memoryForgetTool: ToolDefinition<{ memoryId: string }> = {
  name: "memory.forget",
  description: "Delete one of your own memories. Use only when something you recorded is wrong.",
  inputSchema: z.object({
    memoryId: z.string().describe("Id of the memory to delete"),
  }),
  requiredPermission: PERMISSIONS.MEMORY_WRITE,
  risk: "LOW",
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("memory.forget requires an agent");

    const owned = await context.db.agentMemory.findUnique({ where: { id: input.memoryId } });
    if (owned === null || owned.agentId !== agentId) {
      // Ownership check before deletion: an agent must not be able to erase
      // another agent's memory by guessing an id.
      throw validationError("No such memory belongs to you", { memoryId: input.memoryId });
    }

    await forgetMemory(context.db, input.memoryId, {
      actor: context.actor,
      correlationId: context.correlationId,
    });
    return { data: { deleted: input.memoryId }, summary: "Forgot one memory" };
  },
};

export const memoryTools = [memoryStoreTool, memorySearchTool, memoryForgetTool];
