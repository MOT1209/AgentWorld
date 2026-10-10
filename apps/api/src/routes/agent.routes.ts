import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  changeAgentProvider,
  getAgentState,
  getStateHistory,
  changeAgentState,
  buildRuntimeProfile,
} from "../../../../packages/agents/src/index.js";
import { getProviderRegistry } from "../../../../packages/ai/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { agentRunRateLimit } from "../middleware/rate-limit.js";
import { toAgentDto } from "../dto/index.js";
import { orchestrateAgentRun } from "../services/agent-orchestrator.js";
import { findOrCreateDirectConversation, sendMessage } from "../../../../packages/agents/src/communication.service.js";
import {
  listActivities,
  getOpenActivity,
  listGoals,
  createGoal,
  updateGoal,
  executeAction,
  AgentActionSchema,
  parseVitals,
  listAgentRoutines,
} from "../../../../packages/simulation/src/index.js";

export const agentRouter: Router = Router();
agentRouter.use(authenticate);

agentRouter.get(
  "/",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const agents = await listAgents(prisma, {
        ...(q.companyId !== undefined ? { companyId: q.companyId } : {}),
        ...(q.roleKey !== undefined ? { roleKey: q.roleKey } : {}),
      });
      res.json({ data: agents.map((a) => toAgentDto(a as unknown as Record<string, unknown>)), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(120),
  roleKey: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  systemPrompt: z.string().min(1).max(20000),
  providerId: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(128000).optional(),
  personality: z.record(z.string(), z.unknown()).optional(),
  goals: z.array(z.string().max(500)).max(50).optional(),
  skills: z.array(z.string().max(120)).max(100).optional(),
  capabilities: z.array(z.string().max(120)).max(100).optional(),
  worldId: z.string().min(1).optional().nullable(),
  currentLocationId: z.string().min(1).optional().nullable(),
  currentCompanyId: z.string().min(1).optional().nullable(),
  currentJob: z.string().max(200).optional().nullable(),
  slug: z.string().min(1).max(120).optional(),
});

agentRouter.post(
  "/",
  requirePermission(PERMISSIONS.AGENT_CREATE),
  validate("body", CreateAgentSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateAgentSchema>;
      const agent = await createAgent(
        prisma,
        {
          name: body.name,
          roleKey: body.roleKey,
          title: body.title,
          systemPrompt: body.systemPrompt,
          providerId: body.providerId,
          model: body.model,
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
          ...(body.personality !== undefined ? { personality: body.personality } : {}),
          ...(body.goals !== undefined ? { goals: body.goals } : {}),
          ...(body.skills !== undefined ? { skills: body.skills } : {}),
          ...(body.capabilities !== undefined ? { capabilities: body.capabilities } : {}),
          worldId: body.worldId ?? null,
          currentLocationId: body.currentLocationId ?? null,
          currentCompanyId: body.currentCompanyId ?? null,
          currentJob: body.currentJob ?? null,
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
        },
        {
          actor: principalToActor(principal),
          correlationId: getCorrelationId(req),
          permissions: principal.permissions,
          userId: principal.userId,
        },
      );
      res.status(201).json({ data: toAgentDto(agent as unknown as Record<string, unknown>), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

agentRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const agent = await getAgent(prisma, req.params.id as string);
      res.json({ data: toAgentDto(agent as unknown as Record<string, unknown>), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  title: z.string().min(1).max(200).optional(),
  systemPrompt: z.string().min(1).max(20000).optional(),
  providerId: z.string().min(1).max(80).optional(),
  model: z.string().min(1).max(120).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(128000).optional(),
  goals: z.array(z.string().max(500)).max(50).optional(),
  skills: z.array(z.string().max(120)).max(100).optional(),
  capabilities: z.array(z.string().max(120)).max(100).optional(),
  currentLocationId: z.string().min(1).nullable().optional(),
  currentCompanyId: z.string().min(1).nullable().optional(),
  currentJob: z.string().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
});

agentRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", UpdateAgentSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof UpdateAgentSchema>;
      const agent = await updateAgent(prisma, req.params.id as string, body, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
        permissions: principal.permissions,
        userId: principal.userId,
      });
      res.json({ data: toAgentDto(agent as unknown as Record<string, unknown>), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

agentRouter.get(
  "/:id/state",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const state = await getAgentState(prisma, req.params.id as string);
      const history = await getStateHistory(prisma, req.params.id as string, 20);
      res.json({ data: { state, history }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const ChangeStateSchema = z.object({
  state: z.string().min(1).max(40),
  activity: z.string().max(500).optional().nullable(),
  reason: z.string().max(1000).optional(),
});

agentRouter.post(
  "/:id/state",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", ChangeStateSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof ChangeStateSchema>;
      const state = await changeAgentState(
        prisma,
        { agentId: req.params.id as string, state: body.state, activity: body.activity ?? null, reason: body.reason },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
      );
      res.json({ data: state, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const ChangeProviderSchema = z.object({
  providerId: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  temperature: z.number().min(0).max(2).optional(),
});

agentRouter.post(
  "/:id/provider",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", ChangeProviderSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof ChangeProviderSchema>;
      getProviderRegistry().require(body.providerId);
      const agent = await changeAgentProvider(prisma, req.params.id as string, body, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
        permissions: principal.permissions,
        userId: principal.userId,
      });
      res.json({ data: toAgentDto(agent as unknown as Record<string, unknown>), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

agentRouter.get(
  "/:id/profile",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const profile = await buildRuntimeProfile(prisma, req.params.id as string);
      res.json({
        data: {
          agent: toAgentDto(profile.agent as unknown as Record<string, unknown>),
          role: profile.role,
          effectivePermissions: profile.effectivePermissions,
          goals: profile.goals,
          skills: profile.skills,
          capabilities: profile.capabilities,
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

const RunAgentSchema = z.object({
  trigger: z.enum(["CHAT", "TASK_ASSIGNED", "SCHEDULED", "MANUAL"]).default("MANUAL"),
  conversationId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  userMessage: z.string().min(1).max(8000).optional(),
});

agentRouter.post(
  "/:id/run",
  requirePermission(PERMISSIONS.AGENT_RUN),
  agentRunRateLimit(),
  validate("body", RunAgentSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as z.infer<typeof RunAgentSchema>;
      const result = await orchestrateAgentRun(
        {
          agentId: req.params.id as string,
          trigger: body.trigger,
          ...(body.conversationId !== undefined ? { conversationId: body.conversationId } : {}),
          ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
          ...(body.userMessage !== undefined ? { userMessage: body.userMessage } : {}),
        },
        req,
      );
      res.json({ data: result, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const ChatSchema = z.object({
  content: z.string().min(1).max(8000),
  companyId: z.string().min(1).optional().nullable(),
});

agentRouter.post(
  "/:id/chat",
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  agentRunRateLimit(),
  validate("body", ChatSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const actor = principalToActor(principal);
      const correlationId = getCorrelationId(req);
      const body = req.body as z.infer<typeof ChatSchema>;
      const agentId = req.params.id as string;

      const conversation = await findOrCreateDirectConversation(
        prisma,
        { userId: principal.userId, agentId, companyId: body.companyId ?? null },
        { actor, correlationId, userId: principal.userId },
      );
      await sendMessage(
        prisma,
        {
          conversationId: conversation.id,
          content: body.content,
          senderType: "HUMAN",
          senderUserId: principal.userId,
          kind: "MESSAGE",
          correlationId,
        },
        { actor, correlationId, userId: principal.userId },
      );
      const result = await orchestrateAgentRun(
        { agentId, trigger: "CHAT", conversationId: conversation.id, userMessage: body.content },
        req,
      );
      res.json({ data: { conversationId: conversation.id, run: result }, correlationId });
    } catch (error) {
      next(error);
    }
  },
);

// -- Phase 1 simulation surface ---------------------------------------------

agentRouter.get(
  "/:id/activity",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const agentId = req.params.id as string;
      const q = req.query as Record<string, string | undefined>;
      const [open, history] = await Promise.all([
        getOpenActivity(prisma, agentId),
        listActivities(prisma, {
          agentId,
          ...(q.status !== undefined ? { status: q.status } : {}),
          ...(q.limit !== undefined ? { limit: Number(q.limit) || 25 } : {}),
        }),
      ]);
      res.json({
        data: { open, history, correlationId: getCorrelationId(req) },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

agentRouter.get(
  "/:id/needs",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const state = await getAgentState(prisma, req.params.id as string);
      res.json({ data: parseVitals(state.vitals), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

agentRouter.get(
  "/:id/goals",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const goals = await listGoals(prisma, {
        agentId: req.params.id as string,
        ...(q.status !== undefined ? { status: q.status } : {}),
      });
      res.json({ data: goals, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// Read-only daily-routine schedule (Phase 5 data, surfaced for the 3D
// world's inspector + future movement previews). No writes, no schema change.
agentRouter.get(
  "/:id/routines",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const routines = await listAgentRoutines(prisma, {
        agentId: req.params.id as string,
        ...(q.includeInactive === "true" ? { includeInactive: true as const } : {}),
      });
      res.json({ data: routines, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const CreateGoalSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(2000).nullable().optional(),
  priority: z.string().min(1).max(40).optional(),
  status: z.string().min(1).max(40).optional(),
  progress: z.number().min(0).max(100).optional(),
});

agentRouter.post(
  "/:id/goals",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", CreateGoalSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const agentId = req.params.id as string;
      const body = req.body as z.infer<typeof CreateGoalSchema>;
      const agent = await getAgent(prisma, agentId);
      const goal = await createGoal(
        prisma,
        {
          agentId,
          title: body.title,
          description: body.description ?? null,
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.progress !== undefined ? { progress: body.progress } : {}),
        },
        {
          actor: principalToActor(principal),
          correlationId: getCorrelationId(req),
          worldId: agent.worldId ?? undefined,
        },
      );
      res.status(201).json({ data: goal, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const UpdateGoalSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(2000).nullable().optional(),
  priority: z.string().min(1).max(40).optional(),
  status: z.string().min(1).max(40).optional(),
  progress: z.number().min(0).max(100).optional(),
});

agentRouter.patch(
  "/:id/goals/:goalId",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", UpdateGoalSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof UpdateGoalSchema>;
      const goal = await updateGoal(prisma, req.params.goalId as string, body, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: goal, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

agentRouter.post(
  "/:id/actions",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", AgentActionSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const agentId = req.params.id as string;
      const agent = await getAgent(prisma, agentId);
      const result = await executeAction(prisma, agentId, req.body, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
        worldId: agent.worldId ?? undefined,
        permissions: principal.permissions,
      });
      res.json({ data: result, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
