/**
 * Plan service.
 *
 * A plan is the planner's contract: an objective, ordered milestones, the
 * assumptions it rests on, and the risks it carries. Tasks reference a plan
 * (`Task.planId`), which is what makes "did we actually do what we said"
 * answerable after the fact.
 *
 * State is guarded by `PLAN_TRANSITIONS` from shared, exactly like tasks, so
 * the legal moves are data rather than scattered `if`s. Two rules worth
 * stating:
 *
 *  1. PLANS ARE ATTRIBUTED. Every plan records whether an agent or a human
 *     wrote it. There is no anonymous plan.
 *  2. APPROVAL IS A HUMAN ACT. `plan.approve` is in HUMAN_ONLY_PERMISSIONS, so
 *     no role can ever grant it to an agent; `approvePlan` is the one method
 *     that insists on it. Agents move plans through analysis, never through
 *     sign-off.
 */
import {
  PLAN_TRANSITIONS,
  PlanStatusSchema,
  TaskPrioritySchema,
  conflict,
  forbidden,
  invalidStateTransition,
  newCorrelationId,
  notFound,
  toJson,
  toJsonArray,
  toJsonObject,
  validationError,
  type ActorRef,
  type PlanStatus,
} from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Plan } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";

export interface PlanActorContext {
  actor: ActorRef;
  /** Absent means SYSTEM: unrestricted internal use. */
  permissions?: ReadonlySet<Permission>;
  agentId?: string;
  userId?: string;
  correlationId?: string;
  companyId?: string;
  worldId?: string;
}

export interface CreatePlanInput {
  title: string;
  objective: string;
  description?: string | null;
  priority?: string;
  companyId?: string | null;
  milestones?: string[];
  assumptions?: string[];
  risks?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdatePlanInput {
  title?: string;
  objective?: string;
  description?: string | null;
  priority?: string;
  milestones?: string[];
  assumptions?: string[];
  risks?: string[];
  metadata?: Record<string, unknown>;
}

function has(ctx: PlanActorContext, permission: Permission): boolean {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.permissions === undefined) return true;
  return ctx.permissions.has(permission);
}

function requirePermission(ctx: PlanActorContext, permission: Permission): void {
  if (!has(ctx, permission)) {
    throw forbidden(`Caller lacks '${permission}'`);
  }
}

function priorityOf(value: string | undefined): string {
  const parsed = TaskPrioritySchema.safeParse(value ?? "MEDIUM");
  if (!parsed.success) {
    throw validationError(`Invalid plan priority: ${String(value)}`);
  }
  return parsed.data;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`Plan ${field} is required`);
  }
  return value.trim();
}

function requireStringArray(value: string[] | undefined, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw validationError(`Plan ${field} must be an array of strings`);
  }
  return value;
}

export async function createPlan(
  db: DbClient,
  input: CreatePlanInput,
  ctx: PlanActorContext,
): Promise<Plan> {
  requirePermission(ctx, PERMISSIONS.PLAN_CREATE);

  const title = requireText(input.title, "title");
  const objective = requireText(input.objective, "objective");
  const milestones = requireStringArray(input.milestones, "milestones") ?? [];
  const assumptions = requireStringArray(input.assumptions, "assumptions") ?? [];
  const risks = requireStringArray(input.risks, "risks") ?? [];

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const plan = await db.plan.create({
    data: {
      title,
      objective,
      description: input.description ?? null,
      priority: priorityOf(input.priority),
      status: "DRAFT",
      companyId: input.companyId ?? ctx.companyId ?? null,
      createdByAgentId: ctx.actor.actorType === "AGENT" ? (ctx.agentId ?? null) : null,
      createdByUserId:
        ctx.actor.actorType === "USER" ? (ctx.actor.actorId ?? ctx.userId ?? null) : null,
      milestones: toJson(milestones),
      assumptions: toJson(assumptions),
      risks: toJson(risks),
      metadata: toJson(input.metadata ?? {}),
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.PLAN_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "Plan",
    targetId: plan.id,
    companyId: plan.companyId ?? undefined,
    worldId: ctx.worldId,
    payload: {
      planId: plan.id,
      title: plan.title,
      createdByAgentId: plan.createdByAgentId,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "plan.create",
    targetType: "Plan",
    targetId: plan.id,
    correlationId,
    metadata: { title: plan.title, priority: plan.priority },
  });

  return plan;
}

/**
 * Edit an open plan. Terminal plans are immutable, and a caller without
 * `plan.update` may only edit a plan they authored -- rewriting someone
 * else's plan silently is how delegation trust breaks down.
 */
export async function updatePlan(
  db: DbClient,
  planId: string,
  input: UpdatePlanInput,
  ctx: PlanActorContext,
): Promise<Plan> {
  const plan = await requirePlan(db, planId);
  if (isTerminalPlan(plan.status)) {
    throw conflict("Plan is closed and cannot be edited", { planId: plan.id, status: plan.status });
  }
  assertCanModify(plan, ctx);

  const milestones = requireStringArray(input.milestones, "milestones");
  const assumptions = requireStringArray(input.assumptions, "assumptions");
  const risks = requireStringArray(input.risks, "risks");

  const updated = await db.plan.update({
    where: { id: planId },
    data: {
      ...(input.title !== undefined ? { title: requireText(input.title, "title") } : {}),
      ...(input.objective !== undefined ? { objective: requireText(input.objective, "objective") } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: priorityOf(input.priority) } : {}),
      ...(milestones !== undefined ? { milestones: toJson(milestones) } : {}),
      ...(assumptions !== undefined ? { assumptions: toJson(assumptions) } : {}),
      ...(risks !== undefined ? { risks: toJson(risks) } : {}),
      ...(input.metadata !== undefined ? { metadata: toJson(input.metadata) } : {}),
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "plan.update",
    targetType: "Plan",
    targetId: planId,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    metadata: { changes: Object.keys(input) },
  });

  return updated;
}

/**
 * Move a plan along its state machine. The only gate beyond the transition
 * table is `plan.update`; approval-grade moves go through `approvePlan`.
 */
export async function transitionPlan(
  db: DbClient,
  planId: string,
  to: string,
  ctx: PlanActorContext,
): Promise<Plan> {
  const plan = await requirePlan(db, planId);
  requirePermission(ctx, PERMISSIONS.PLAN_UPDATE);

  const from = PlanStatusSchema.parse(plan.status);
  const target = PlanStatusSchema.parse(to);
  if (from === target) return plan;

  const allowed = PLAN_TRANSITIONS[from];
  if (!allowed.includes(target)) {
    throw invalidStateTransition(from, target, "Plan");
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const updated = await db.plan.update({ where: { id: planId }, data: { status: target } });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.PLAN_STATUS_CHANGED,
    actor: ctx.actor,
    correlationId,
    targetType: "Plan",
    targetId: planId,
    companyId: plan.companyId ?? undefined,
    worldId: ctx.worldId,
    payload: { planId, fromStatus: from, toStatus: target },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "plan.transition",
    targetType: "Plan",
    targetId: planId,
    correlationId,
    metadata: { from, to: target },
  });

  return updated;
}

/**
 * Human sign-off. Requires `plan.approve`, which is HUMAN_ONLY, so this
 * cannot be reached by any agent role no matter how it is configured.
 */
export async function approvePlan(
  db: DbClient,
  planId: string,
  ctx: PlanActorContext,
): Promise<Plan> {
  requirePermission(ctx, PERMISSIONS.PLAN_APPROVE);
  const plan = await requirePlan(db, planId);

  const from = PlanStatusSchema.parse(plan.status);
  if (from !== "READY") {
    throw conflict("Only a READY plan can be approved", { planId, status: from });
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const updated = await db.plan.update({
    where: { id: planId },
    data: {
      status: "EXECUTING",
      metadata: toJson({
        ...toJsonObject(plan.metadata),
        approvedBy: ctx.actor.actorId ?? null,
        approvedAt: new Date().toISOString(),
      }),
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.PLAN_APPROVED,
    actor: ctx.actor,
    correlationId,
    targetType: "Plan",
    targetId: planId,
    companyId: plan.companyId ?? undefined,
    worldId: ctx.worldId,
    payload: { planId, approvedByUserId: ctx.actor.actorId ?? "system" },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.PLAN_STATUS_CHANGED,
    actor: ctx.actor,
    correlationId,
    targetType: "Plan",
    targetId: planId,
    companyId: plan.companyId ?? undefined,
    worldId: ctx.worldId,
    payload: { planId, fromStatus: from, toStatus: "EXECUTING" },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "plan.approve",
    targetType: "Plan",
    targetId: planId,
    correlationId,
    metadata: { from, to: "EXECUTING" },
  });

  return updated;
}

export async function getPlan(db: DbClient, planId: string): Promise<Plan> {
  return requirePlan(db, planId);
}

export interface ListPlansQuery {
  status?: string | string[];
  companyId?: string;
  createdByAgentId?: string;
  priority?: string;
  skip?: number;
  take?: number;
}

export async function listPlans(db: DbClient, query: ListPlansQuery = {}) {
  const statuses =
    query.status === undefined
      ? undefined
      : Array.isArray(query.status)
        ? query.status
        : [query.status];

  return db.plan.findMany({
    where: {
      ...(statuses !== undefined ? { status: { in: statuses } } : {}),
      ...(query.companyId !== undefined ? { companyId: query.companyId } : {}),
      ...(query.createdByAgentId !== undefined ? { createdByAgentId: query.createdByAgentId } : {}),
      ...(query.priority !== undefined ? { priority: query.priority } : {}),
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    skip: query.skip ?? 0,
    take: Math.min(query.take ?? 50, 200),
  });
}

/** Plans whose tasks still owe work -- the execution queue a planner reads. */
export async function listExecutingPlans(db: DbClient, companyId?: string): Promise<Plan[]> {
  return db.plan.findMany({
    where: {
      status: { in: ["EXECUTING", "PAUSED"] },
      ...(companyId !== undefined ? { companyId } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
}

// -- Read helpers ------------------------------------------------------------

export function planMilestones(plan: Plan): string[] {
  return toJsonArray(plan.milestones);
}

export function planAssumptions(plan: Plan): string[] {
  return toJsonArray(plan.assumptions);
}

export function planRisks(plan: Plan): string[] {
  return toJsonArray(plan.risks);
}

export function planMetadata(plan: Plan): Record<string, unknown> {
  return toJsonObject(plan.metadata);
}

export function isTerminalPlan(status: string): boolean {
  return status === "COMPLETED" || status === "CANCELLED";
}

export function allowedPlanTransitions(status: string): readonly PlanStatus[] {
  return PLAN_TRANSITIONS[PlanStatusSchema.parse(status)];
}

// -- Internal ----------------------------------------------------------------

async function requirePlan(db: DbClient, planId: string): Promise<Plan> {
  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (plan === null) throw notFound("Plan", planId);
  return plan;
}

function assertCanModify(plan: Plan, ctx: PlanActorContext): void {
  if (ctx.actor.actorType === "SYSTEM") return;
  if (has(ctx, PERMISSIONS.PLAN_UPDATE)) return;

  const isAuthorAgent = ctx.agentId !== undefined && plan.createdByAgentId === ctx.agentId;
  const isAuthorUser = ctx.actor.actorType === "USER" && plan.createdByUserId === ctx.actor.actorId;
  if (!isAuthorAgent && !isAuthorUser) {
    throw forbidden("Only the author or a planner may modify this plan", { planId: plan.id });
  }
}
