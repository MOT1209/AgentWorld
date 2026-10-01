/**
 * Agent session service.
 *
 * An AgentSession is the observability record of one bounded execution run:
 * the King inspects this instead of the model's private context. Lifecycle:
 *
 *   INITIALIZING -> RUNNING <-> WAITING -> COMPLETED | FAILED | CANCELLED
 *
 * Rules worth stating:
 *
 *  1. SESSIONS ARE OWNED. An agent may only open, touch, or finish its own
 *     sessions. Humans (USER actor) and SYSTEM may act on any session.
 *  2. TERMINAL IS FINAL. Once COMPLETED, FAILED, or CANCELLED, a session row
 *     never moves again. A retry is a new session, so history stays honest.
 *  3. PROVIDER IS RECORDED, NOT CHOSEN HERE. The caller passes the resolved
 *     provider/model (after ModelRouter); this service persists what actually
 *     ran so routing decisions stay auditable.
 */
import {
  SessionStatusSchema,
  conflict,
  forbidden,
  fromJson,
  newCorrelationId,
  notFound,
  toJson,
  toJsonArray,
  validationError,
  type ActorRef,
} from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { AgentSession } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";

export interface SessionActorContext {
  actor: ActorRef;
  /** Absent means SYSTEM: unrestricted internal use. */
  permissions?: ReadonlySet<Permission>;
  agentId?: string;
  userId?: string;
  correlationId?: string;
  companyId?: string;
  worldId?: string;
}

export interface StartSessionInput {
  agentId: string;
  providerId?: string | null;
  model?: string | null;
  taskId?: string | null;
  /** CHAT | TASK_ASSIGNED | SCHEDULED | MANUAL. Free text is rejected. */
  trigger?: string;
  /** JSON-safe context snapshot: taskType, planId, conversationId, ... */
  context?: Record<string, unknown>;
}

export interface ToolCallRecord {
  name: string;
  status: string;
  durationMs?: number;
  approvalRequestId?: string | null;
}

export interface FinishSessionInput {
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  result?: string | null;
  error?: string | null;
}

const TRIGGERS = ["CHAT", "TASK_ASSIGNED", "SCHEDULED", "MANUAL"] as const;

function has(ctx: SessionActorContext, permission: Permission): boolean {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.permissions === undefined) return true;
  return ctx.permissions.has(permission);
}

function requirePermission(ctx: SessionActorContext, permission: Permission): void {
  if (!has(ctx, permission)) {
    throw forbidden(`Caller lacks '${permission}'`);
  }
}

/** Agents act on their own sessions only; humans and SYSTEM act on any. */
function assertOwner(ctx: SessionActorContext, session: AgentSession): void {
  if (ctx.actor.actorType === "SYSTEM") return;
  if (ctx.agentId !== undefined) {
    if (session.agentId !== ctx.agentId) {
      throw forbidden("Agents may only touch their own sessions");
    }
    return;
  }
  if (ctx.actor.actorType !== "USER") {
    throw forbidden("Session access requires an agent owner or a human");
  }
}

function assertOpen(session: AgentSession): void {
  if (session.status === "COMPLETED" || session.status === "FAILED" || session.status === "CANCELLED") {
    throw conflict("Session is already closed", { sessionId: session.id, status: session.status });
  }
}

export async function startSession(
  db: DbClient,
  input: StartSessionInput,
  ctx: SessionActorContext,
): Promise<AgentSession> {
  requirePermission(ctx, PERMISSIONS.SESSION_START);

  if (ctx.agentId !== undefined && ctx.agentId !== input.agentId) {
    throw forbidden("Agents may only open sessions for themselves");
  }

  const agent = await db.agent.findUnique({ where: { id: input.agentId } });
  if (agent === null) throw notFound("Agent", input.agentId);

  const trigger = input.trigger ?? "MANUAL";
  if (!(TRIGGERS as readonly string[]).includes(trigger)) {
    throw validationError(`Unknown session trigger: ${trigger}`);
  }

  if (input.taskId != null) {
    const task = await db.task.findUnique({ where: { id: input.taskId }, select: { id: true } });
    if (task === null) throw notFound("Task", input.taskId);
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const session = await db.agentSession.create({
    data: {
      agentId: agent.id,
      providerId: input.providerId ?? agent.providerId,
      model: input.model ?? agent.model,
      taskId: input.taskId ?? null,
      status: "INITIALIZING",
      context: toJson({ trigger, ...(input.context ?? {}) }),
      toolCalls: "[]",
      correlationId,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.SESSION_STARTED,
    actor: ctx.actor,
    correlationId,
    targetType: "AgentSession",
    targetId: session.id,
    companyId: agent.currentCompanyId ?? ctx.companyId ?? undefined,
    worldId: agent.worldId ?? ctx.worldId ?? undefined,
    payload: { sessionId: session.id, agentId: agent.id, trigger },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "session.start",
    targetType: "AgentSession",
    targetId: session.id,
    correlationId,
    userId: ctx.userId,
    metadata: { agentId: agent.id, providerId: session.providerId, model: session.model, trigger },
  });

  return session;
}

export async function getSession(db: DbClient, sessionId: string): Promise<AgentSession> {
  const session = await db.agentSession.findUnique({ where: { id: sessionId } });
  if (session === null) throw notFound("AgentSession", sessionId);
  return session;
}

export interface ListSessionsQuery {
  agentId?: string;
  taskId?: string;
  status?: string | string[];
  take?: number;
  skip?: number;
}

export async function listSessions(db: DbClient, query: ListSessionsQuery = {}): Promise<AgentSession[]> {
  const statuses =
    query.status === undefined ? undefined : Array.isArray(query.status) ? query.status : [query.status];
  return db.agentSession.findMany({
    where: {
      ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
      ...(query.taskId !== undefined ? { taskId: query.taskId } : {}),
      ...(statuses !== undefined ? { status: { in: statuses } } : {}),
    },
    orderBy: { startedAt: "desc" },
    take: Math.min(query.take ?? 50, 200),
    skip: query.skip ?? 0,
  });
}

/** Move a session between non-terminal states (INITIALIZING/RUNNING/WAITING). */
export async function transitionSession(
  db: DbClient,
  sessionId: string,
  to: string,
  ctx: SessionActorContext,
): Promise<AgentSession> {
  const target = SessionStatusSchema.parse(to);
  if (target === "COMPLETED" || target === "FAILED" || target === "CANCELLED") {
    throw validationError("Terminal states are reached via finishSession, not transitionSession");
  }

  const session = await getSession(db, sessionId);
  assertOwner(ctx, session);
  assertOpen(session);

  const correlationId = ctx.correlationId ?? newCorrelationId();
  return db.agentSession.update({ where: { id: session.id }, data: { status: target } }).then(async (updated) => {
    await recordActivity(db, {
      actor: ctx.actor,
      action: "session.transition",
      targetType: "AgentSession",
      targetId: session.id,
      correlationId,
      metadata: { from: session.status, to: target },
    });
    return updated;
  });
}

export async function appendSessionToolCall(
  db: DbClient,
  sessionId: string,
  call: ToolCallRecord,
  ctx: SessionActorContext,
): Promise<AgentSession> {
  const session = await getSession(db, sessionId);
  assertOwner(ctx, session);
  assertOpen(session);

  const calls = fromJson<Array<Record<string, unknown>>>(session.toolCalls, []);
  calls.push({
    name: call.name,
    status: call.status,
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    ...(call.approvalRequestId != null ? { approvalRequestId: call.approvalRequestId } : {}),
  });
  return db.agentSession.update({
    where: { id: session.id },
    data: { toolCalls: toJson(calls) },
  });
}

export async function finishSession(
  db: DbClient,
  sessionId: string,
  input: FinishSessionInput,
  ctx: SessionActorContext,
): Promise<AgentSession> {
  const session = await getSession(db, sessionId);
  assertOwner(ctx, session);
  assertOpen(session);

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const finished = await db.agentSession.update({
    where: { id: session.id },
    data: {
      status: input.status,
      result: input.result ?? null,
      error: input.error?.slice(0, 2000) ?? null,
      endedAt: new Date(),
    },
  });

  const agent = await db.agent.findUnique({
    where: { id: session.agentId },
    select: { currentCompanyId: true, worldId: true },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.SESSION_FINISHED,
    actor: ctx.actor,
    correlationId,
    targetType: "AgentSession",
    targetId: session.id,
    companyId: agent?.currentCompanyId ?? ctx.companyId ?? undefined,
    worldId: agent?.worldId ?? ctx.worldId ?? undefined,
    payload: { sessionId: session.id, agentId: session.agentId, status: input.status },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "session.finish",
    targetType: "AgentSession",
    targetId: session.id,
    correlationId,
    userId: ctx.userId,
    metadata: { status: input.status, toolCalls: toJsonArray(session.toolCalls).length },
  });

  return finished;
}

export function sessionToolCalls(session: AgentSession): Array<Record<string, unknown>> {
  return fromJson<Array<Record<string, unknown>>>(session.toolCalls, []);
}
