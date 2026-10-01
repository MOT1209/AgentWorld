import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  createConversation,
  listConversations,
  getConversationDetail,
  sendMessage,
  closeConversation,
  markConversationRead,
} from "../../../../packages/agents/src/communication.service.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { toMessageDto } from "../dto/index.js";
import { orchestrateAgentRun } from "../services/agent-orchestrator.js";

export const conversationRouter: Router = Router();
conversationRouter.use(authenticate);

const CreateConversationSchema = z.object({
  kind: z.enum(["HUMAN_AGENT", "AGENT_AGENT", "SYSTEM"]),
  title: z.string().min(1).max(200),
  companyId: z.string().min(1).optional().nullable(),
  participantAgentIds: z.array(z.string().min(1)).max(50).optional(),
});

conversationRouter.post(
  "/",
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  validate("body", CreateConversationSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateConversationSchema>;
      const conversation = await createConversation(
        prisma,
        {
          kind: body.kind,
          title: body.title,
          companyId: body.companyId ?? null,
          createdByUserId: principal.userId,
          participantAgentIds: body.participantAgentIds,
        },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req), userId: principal.userId },
      );
      res.status(201).json({ data: conversation, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

conversationRouter.get(
  "/",
  requirePermission(PERMISSIONS.MESSAGE_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const conversations = await listConversations(prisma, {
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        ...(q.companyId !== undefined ? { companyId: q.companyId } : {}),
        ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: conversations, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

conversationRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.MESSAGE_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const detail = await getConversationDetail(prisma, req.params.id as string);
      res.json({
        data: {
          ...detail,
          messages: detail.messages.map((m) => toMessageDto(m as unknown as Record<string, unknown>)),
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

const SendMessageSchema = z.object({
  content: z.string().min(1).max(8000),
  kind: z.enum(["MESSAGE", "PLAN", "REPORT", "REQUEST", "QUESTION", "APPROVAL_REQUEST", "TOOL_RESULT", "TASK_RESULT", "SYSTEM_NOTICE"]).default("MESSAGE"),
  taskId: z.string().min(1).optional().nullable(),
  wakeAgent: z.boolean().default(true),
});

conversationRouter.post(
  "/:id/messages",
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  validate("body", SendMessageSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const actor = principalToActor(principal);
      const correlationId = getCorrelationId(req);
      const body = req.body as z.infer<typeof SendMessageSchema>;
      const conversationId = req.params.id as string;

      const sent = await sendMessage(
        prisma,
        {
          conversationId,
          content: body.content,
          senderType: "HUMAN",
          senderUserId: principal.userId,
          kind: body.kind,
          taskId: body.taskId ?? null,
          correlationId,
        },
        { actor, correlationId, userId: principal.userId },
      );

      let run: unknown = null;
      if (body.wakeAgent && sent.notifyAgentId !== null) {
        run = await orchestrateAgentRun(
          { agentId: sent.notifyAgentId, trigger: "CHAT", conversationId, userMessage: body.content },
          req,
        );
      }

      res.status(201).json({
        data: { message: toMessageDto(sent.message as unknown as Record<string, unknown>), notifyAgentId: sent.notifyAgentId, run },
        correlationId,
      });
    } catch (error) {
      next(error);
    }
  },
);

conversationRouter.post(
  "/:id/read",
  requirePermission(PERMISSIONS.MESSAGE_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { agentId?: string };
      if (typeof body.agentId !== "string") {
        res.status(400).json({ code: "VALIDATION_ERROR", message: "agentId is required", correlationId: getCorrelationId(req) });
        return;
      }
      await markConversationRead(prisma, req.params.id as string, body.agentId);
      res.json({ data: { ok: true }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

conversationRouter.post(
  "/:id/close",
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const conversation = await closeConversation(prisma, req.params.id as string);
      res.json({ data: conversation, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
