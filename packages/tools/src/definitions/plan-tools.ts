/**
 * Plan tools.
 *
 * Plans are proposed by agents and signed off by humans: `plan.create` and
 * `plan.update` move a plan through analysis, while approval lives behind the
 * human-only `approvePlan` service (exposed over HTTP, never as a tool).
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import {
  createPlan,
  getPlan,
  listPlans,
  updatePlan,
  planMilestones,
} from "../../../orchestration/src/index.js";
import type { ToolDefinition } from "../types.js";

function planSummary(id: string, title: string, status: string): string {
  return `Plan ${id} "${title}" (${status})`;
}

export const planCreateTool: ToolDefinition<{
  title: string;
  objective: string;
  description?: string;
  priority?: "LOW" | "MEDIUM" | "NORMAL" | "HIGH" | "URGENT" | "CRITICAL";
  companyId?: string;
  milestones?: string[];
  assumptions?: string[];
  risks?: string[];
}> = {
  name: "plan.create",
  description:
    "Draft a plan: objective, ordered milestones, assumptions, and risks. " +
    "Plans are attributed to you. Human sign-off happens outside this tool.",
  inputSchema: z.object({
    title: z.string().min(3).max(200),
    objective: z.string().min(10).max(5000),
    description: z.string().max(5000).optional(),
    priority: z.enum(["LOW", "MEDIUM", "NORMAL", "HIGH", "URGENT", "CRITICAL"]).default("MEDIUM"),
    companyId: z.string().optional(),
    milestones: z.array(z.string().min(1).max(500)).max(50).optional(),
    assumptions: z.array(z.string().min(1).max(500)).max(50).optional(),
    risks: z.array(z.string().min(1).max(500)).max(50).optional(),
  }),
  requiredPermission: PERMISSIONS.PLAN_CREATE,
  risk: "LOW",
  async execute(context, input) {
    const plan = await createPlan(
      context.db,
      {
        title: input.title,
        objective: input.objective,
        ...(input.description !== undefined ? { description: input.description } : {}),
        priority: input.priority,
        companyId: input.companyId ?? context.companyId ?? null,
        ...(input.milestones !== undefined ? { milestones: input.milestones } : {}),
        ...(input.assumptions !== undefined ? { assumptions: input.assumptions } : {}),
        ...(input.risks !== undefined ? { risks: input.risks } : {}),
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
      data: { id: plan.id, title: plan.title, status: plan.status, milestones: planMilestones(plan) },
      summary: planSummary(plan.id, plan.title, plan.status),
    };
  },
};

export const planUpdateTool: ToolDefinition<{
  planId: string;
  title?: string;
  objective?: string;
  description?: string | null;
  milestones?: string[];
  assumptions?: string[];
  risks?: string[];
}> = {
  name: "plan.update",
  description: "Edit an open plan you authored (or any plan, with plan.update). Closed plans are immutable.",
  inputSchema: z.object({
    planId: z.string(),
    title: z.string().min(3).max(200).optional(),
    objective: z.string().min(10).max(5000).optional(),
    description: z.string().max(5000).nullable().optional(),
    milestones: z.array(z.string().min(1).max(500)).max(50).optional(),
    assumptions: z.array(z.string().min(1).max(500)).max(50).optional(),
    risks: z.array(z.string().min(1).max(500)).max(50).optional(),
  }),
  requiredPermission: PERMISSIONS.PLAN_UPDATE,
  risk: "LOW",
  async execute(context, input) {
    const { planId, ...rest } = input;
    const plan = await updatePlan(context.db, planId, rest, {
      actor: context.actor,
      correlationId: context.correlationId,
      permissions: context.permissions,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(context.actor.actorType === "USER" && context.actor.actorId !== undefined
        ? { userId: context.actor.actorId }
        : {}),
    });
    return {
      data: { id: plan.id, title: plan.title, status: plan.status },
      summary: planSummary(plan.id, plan.title, plan.status),
    };
  },
};

export const planListTool: ToolDefinition<{
  status?: string;
  companyId?: string;
  limit?: number;
}> = {
  name: "plan.list",
  description: "List plans, optionally filtered by status or company.",
  inputSchema: z.object({
    status: z.string().optional(),
    companyId: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  requiredPermission: PERMISSIONS.PLAN_READ,
  risk: "LOW",
  async execute(context, input) {
    const plans = await listPlans(context.db, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.companyId ?? context.companyId !== undefined
        ? { companyId: input.companyId ?? (context.companyId as string) }
        : {}),
      take: input.limit,
    });
    return {
      data: {
        plans: plans.map((plan) => ({ id: plan.id, title: plan.title, status: plan.status, priority: plan.priority })),
      },
      summary: `${plans.length} plan(s)`,
    };
  },
};

export const planGetTool: ToolDefinition<{ planId: string }> = {
  name: "plan.get",
  description: "Read one plan in full: milestones, assumptions, risks, and status.",
  inputSchema: z.object({ planId: z.string() }),
  requiredPermission: PERMISSIONS.PLAN_READ,
  risk: "LOW",
  async execute(context, input) {
    const plan = await getPlan(context.db, input.planId);
    return {
      data: {
        id: plan.id,
        title: plan.title,
        objective: plan.objective,
        description: plan.description,
        status: plan.status,
        priority: plan.priority,
        milestones: planMilestones(plan),
      },
      summary: planSummary(plan.id, plan.title, plan.status),
    };
  },
};

export const planTools = [planCreateTool, planUpdateTool, planListTool, planGetTool];
