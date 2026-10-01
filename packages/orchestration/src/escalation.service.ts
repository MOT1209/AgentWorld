/**
 * Escalation service.
 *
 * Escalation is the pressure valve of the hierarchy: an agent that is blocked,
 * under-equipped, or out of its depth raises a structured escalation instead
 * of guessing or silently failing. Two properties make it trustworthy:
 *
 *  1. ROUTING IS STRUCTURAL. With no explicit target, the service walks the
 *     role hierarchy (`RoleProfile.reportsTo`) and hands the escalation to a
 *     live agent in the supervisor role. When the chain reaches a root role
 *     (or no live supervisor exists) the escalation is left unrouted, which
 *     means "a human must look at this". Nobody ever names Ahmad or Rashid.
 *
 *  2. ESCALATIONS ARE BOUNDED. Status moves OPEN -> ACKNOWLEDGED -> RESOLVED
 *     (or REJECTED). Re-resolving a closed escalation is a conflict, so an
 *     escalation can never become a loop of its own.
 */
import {
  EscalationCategorySchema,
  EscalationStatusSchema,
  conflict,
  forbidden,
  newCorrelationId,
  notFound,
  validationError,
} from "../../shared/src/index.js";
import type { ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Escalation } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";
import { roleProfiles } from "../../agents/src/role-profiles.js";

export interface EscalationActorContext {
  actor: ActorRef;
  /** Absent means SYSTEM: unrestricted internal use. */
  permissions?: ReadonlySet<Permission>;
  agentId?: string;
  userId?: string;
  correlationId?: string;
  companyId?: string;
  worldId?: string;
}

export interface RaiseEscalationInput {
  fromAgentId: string;
  category: string;
  detail: string;
  taskId?: string | null;
  planId?: string | null;
  approvalRequestId?: string | null;
  /** Explicit targets. When omitted the service routes via the hierarchy. */
  toAgentId?: string | null;
  toUserId?: string | null;
}

function has(ctx: EscalationActorContext, permission: Permission): boolean {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.permissions === undefined) return true;
  return ctx.permissions.has(permission);
}

/** Supervisor of the raiser's role, as a live agent, or null = human. */
async function routeByHierarchy(
  db: DbClient,
  fromAgentId: string,
): Promise<{ toAgentId: string | null; toUserId: null; routed: "AGENT" | "HUMAN" }> {
  const from = await db.agent.findUnique({
    where: { id: fromAgentId },
    select: { id: true, roleKey: true },
  });
  if (from === null) throw notFound("Agent", fromAgentId);

  const supervisorRole = roleProfiles.escalationTarget(from.roleKey);
  if (supervisorRole === undefined) {
    return { toAgentId: null, toUserId: null, routed: "HUMAN" };
  }

  const supervisors = await db.agent.findMany({
    where: { roleKey: supervisorRole, isActive: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 1,
  });

  const target = supervisors[0];
  if (target === undefined) {
    // The role exists but nobody is home: still a human's problem.
    return { toAgentId: null, toUserId: null, routed: "HUMAN" };
  }
  return { toAgentId: target.id, toUserId: null, routed: "AGENT" };
}

export async function raiseEscalation(
  db: DbClient,
  input: RaiseEscalationInput,
  ctx: EscalationActorContext,
): Promise<Escalation> {
  if (!has(ctx, PERMISSIONS.ESCALATE)) {
    throw forbidden("Caller lacks 'agent.escalate'");
  }

  const category = EscalationCategorySchema.parse(input.category);
  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  if (detail.length < 10) {
    throw validationError("Escalation detail must explain the problem in at least 10 characters");
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();

  let toAgentId = input.toAgentId ?? null;
  let toUserId = input.toUserId ?? null;
  let routed: "AGENT" | "HUMAN" | "EXPLICIT" = "EXPLICIT";

  if (toAgentId === null && toUserId === null) {
    const route = await routeByHierarchy(db, input.fromAgentId);
    toAgentId = route.toAgentId;
    toUserId = route.toUserId;
    routed = route.routed;
  }

  const escalation = await db.escalation.create({
    data: {
      fromAgentId: input.fromAgentId,
      toAgentId,
      toUserId,
      taskId: input.taskId ?? null,
      planId: input.planId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      category,
      detail,
      status: "OPEN",
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.ESCALATION_RAISED,
    actor: ctx.actor,
    correlationId,
    targetType: "Escalation",
    targetId: escalation.id,
    companyId: ctx.companyId,
    worldId: ctx.worldId,
    payload: {
      escalationId: escalation.id,
      taskId: escalation.taskId,
      category,
      raisedByAgentId: input.fromAgentId,
      toAgentId,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "escalation.raise",
    targetType: "Escalation",
    targetId: escalation.id,
    correlationId,
    metadata: { category, routed, toAgentId, taskId: escalation.taskId ?? null },
  });

  return escalation;
}

export interface ResolveEscalationInput {
  escalationId: string;
  /** Resolved (handled) or rejected (not going to be handled). */
  outcome: "RESOLVED" | "REJECTED";
  resolution: string;
}

export async function resolveEscalation(
  db: DbClient,
  input: ResolveEscalationInput,
  ctx: EscalationActorContext,
): Promise<Escalation> {
  const escalation = await requireEscalation(db, input.escalationId);
  const status = EscalationStatusSchema.parse(escalation.status);

  if (status === "RESOLVED" || status === "REJECTED") {
    throw conflict("Escalation is already closed", { escalationId: escalation.id, status });
  }

  const resolution = input.resolution.trim();
  if (resolution.length < 5) {
    throw validationError("A resolution must say what was decided");
  }

  assertCanResolve(escalation, ctx);

  const now = new Date();
  const updated = await db.escalation.update({
    where: { id: escalation.id },
    data: { status: input.outcome, resolution, resolvedAt: now },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.ESCALATION_RESOLVED,
    actor: ctx.actor,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "Escalation",
    targetId: escalation.id,
    companyId: ctx.companyId,
    worldId: ctx.worldId,
    payload: {
      escalationId: escalation.id,
      resolution: input.outcome,
      resolvedByAgentId: ctx.agentId ?? null,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "escalation.resolve",
    targetType: "Escalation",
    targetId: escalation.id,
    metadata: { outcome: input.outcome, category: escalation.category },
  });

  return updated;
}

/** The recipient takes ownership. Pure bookkeeping -- no authority granted. */
export async function acknowledgeEscalation(
  db: DbClient,
  escalationId: string,
  ctx: EscalationActorContext,
): Promise<Escalation> {
  const escalation = await requireEscalation(db, escalationId);
  if (EscalationStatusSchema.parse(escalation.status) !== "OPEN") {
    throw conflict("Only an OPEN escalation can be acknowledged", {
      escalationId,
      status: escalation.status,
    });
  }
  assertCanResolve(escalation, ctx);

  return db.escalation.update({
    where: { id: escalationId },
    data: { status: "ACKNOWLEDGED" },
  });
}

export interface ListEscalationsQuery {
  status?: string | string[];
  toAgentId?: string;
  fromAgentId?: string;
  category?: string;
  taskId?: string;
  skip?: number;
  take?: number;
}

export async function listEscalations(db: DbClient, query: ListEscalationsQuery = {}) {
  const statuses =
    query.status === undefined
      ? undefined
      : Array.isArray(query.status)
        ? query.status
        : [query.status];

  return db.escalation.findMany({
    where: {
      ...(statuses !== undefined ? { status: { in: statuses } } : {}),
      ...(query.toAgentId !== undefined ? { toAgentId: query.toAgentId } : {}),
      ...(query.fromAgentId !== undefined ? { fromAgentId: query.fromAgentId } : {}),
      ...(query.category !== undefined ? { category: query.category } : {}),
      ...(query.taskId !== undefined ? { taskId: query.taskId } : {}),
    },
    orderBy: { createdAt: "desc" },
    skip: query.skip ?? 0,
    take: Math.min(query.take ?? 50, 200),
  });
}

/** Unrouted or open escalations awaiting a human. The King's dashboard query. */
export async function listHumanEscalations(db: DbClient): Promise<Escalation[]> {
  return db.escalation.findMany({
    where: { status: { in: ["OPEN", "ACKNOWLEDGED"] }, toAgentId: null },
    orderBy: { createdAt: "asc" },
  });
}

export async function requireEscalation(db: DbClient, id: string): Promise<Escalation> {
  const escalation = await db.escalation.findUnique({ where: { id } });
  if (escalation === null) throw notFound("Escalation", id);
  return escalation;
}

/**
 * The recipient may close what was addressed to them; humans and the system
 * may close anything. Anyone else -- including the raiser -- may not: an agent
 * must not be able to mark its own problem solved.
 */
function assertCanResolve(escalation: Escalation, ctx: EscalationActorContext): void {
  if (ctx.actor.actorType === "SYSTEM") return;
  if (ctx.actor.actorType === "USER") return;

  const isRecipient = ctx.agentId !== undefined && escalation.toAgentId === ctx.agentId;
  if (!isRecipient) {
    throw forbidden("Only the escalation recipient may act on this escalation", {
      escalationId: escalation.id,
      agentId: ctx.agentId ?? null,
    });
  }
}


