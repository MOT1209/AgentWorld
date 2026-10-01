import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  storeMemory,
  listMemories,
  retrieveMemories,
  forgetMemory,
  getMemoryStats,
} from "../../../../packages/memory/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";

export const memoryRouter: Router = Router();
memoryRouter.use(authenticate);

const StoreMemorySchema = z.object({
  agentId: z.string().min(1),
  kind: z.enum(["SHORT_TERM", "LONG_TERM", "EPISODIC", "FACT"]),
  content: z.string().min(1).max(4000),
  importance: z.number().int().min(1).max(10).default(5),
  source: z.enum(["CONVERSATION", "TASK", "EVENT", "TOOL", "OBSERVATION", "HUMAN", "SYSTEM"]).default("HUMAN"),
  taskId: z.string().min(1).optional().nullable(),
  conversationId: z.string().min(1).optional().nullable(),
});

memoryRouter.post(
  "/",
  requirePermission(PERMISSIONS.MEMORY_WRITE),
  validate("body", StoreMemorySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof StoreMemorySchema>;
      const memory = await storeMemory(
        prisma,
        {
          agentId: body.agentId,
          kind: body.kind,
          content: body.content,
          importance: body.importance,
          source: body.source,
          taskId: body.taskId ?? null,
          conversationId: body.conversationId ?? null,
        },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
      );
      res.status(201).json({ data: memory, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

memoryRouter.get(
  "/",
  requirePermission(PERMISSIONS.MEMORY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      if (q.agentId === undefined) {
        res.status(400).json({ code: "VALIDATION_ERROR", message: "agentId query is required", correlationId: getCorrelationId(req) });
        return;
      }
      if (q.stats === "true") {
        const stats = await getMemoryStats(prisma, q.agentId);
        res.json({ data: stats, correlationId: getCorrelationId(req) });
        return;
      }
      if (q.query !== undefined) {
        const results = await retrieveMemories(prisma, {
          agentId: q.agentId,
          query: q.query,
          ...(q.kind !== undefined ? { kinds: [q.kind] } : {}),
          limit: q.limit !== undefined ? Math.min(25, Number(q.limit) || 8) : 8,
        });
        res.json({ data: results, correlationId: getCorrelationId(req) });
        return;
      }
      const memories = await listMemories(prisma, {
        agentId: q.agentId,
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        limit: q.limit !== undefined ? Math.min(200, Number(q.limit) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: memories, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

memoryRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.MEMORY_WRITE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      await forgetMemory(prisma, req.params.id as string, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: { ok: true }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
