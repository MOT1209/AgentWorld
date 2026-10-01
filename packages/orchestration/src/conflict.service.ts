/**
 * Decision conflict service.
 *
 * A conflict exists when two live decisions disagree â€” two plans proposing
 * incompatible assignments, contradictory task states, two agents taking
 * opposite positions on the same issue. Conflicts are *raised* with their
 * participants and positions recorded verbatim, then *settled* by a human or
 * the system. Agents may raise but never settle: otherwise an agent could
 * raise a conflict and immediately resolve it in its own favor.
 */
import {
  ConflictStatusSchema,
  conflict as conflictError,
  forbidden,
  newCorrelationId,
  notFound,
  validationError,
} from "../../shared/src/index.js";
import type { ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { DecisionConflict } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import type { Permission } from "../../security/src/permissions.js";
import { toJson } from "../../shared/src/json.js";

export interface ConflictActorContext {
  actor: ActorRef;
  permissions?: ReadonlySet<Permission>;
  agentId?: string;
  userId?: string;
  correlationId?: string;
  companyId?: string;
  worldId?: string;
}

export interface ConflictParticipant {
  agentId: string;
  position: string;
  evidence?: string;
}

export interface RaiseConflictInput {
  /** What the participants disagree about. */
  issue: string;
  participants: ConflictParticipant[];
  /** Positions as free-form JSON plus an optional proposed resolution. */
  positions?: Record<string, unknown>;
  evidence?: string | null;
  taskId?: string | null;
  planId?: string | null;
  /** Start in DISCUSSING (default OPEN). */
  status?: "OPEN" | "DISCUSSING";
}

export interface ResolveConflictInput {
  conflictId: string;
  resolution: string;
  /** "ACCEPT_LEFT" | "ACCEPT_RIGHT" | "MERGE" | "ABANDON" â€” recorded verbatim. */
  decision: string;
}

export async function raiseConflict(
  db: DbClient,
  input: RaiseConflictInput,
  ctx: ConflictActorContext,
): Promise<DecisionConflict> {
  const issue = typeof input.issue === "string" ? input.issue.trim() : "";
  if (issue.length < 5) {
    throw validationError("A conflict needs a clear issue (at least 5 characters)");
  }
  if (input.participants.length < 2) {
    throw validationError("A conflict needs at least two participants");
  }

  const status = input.status ?? "OPEN";
  ConflictStatusSchema.parse(status);

  const correlationId = ctx.correlationId ?? newCorrelationId();

  const row = await db.decisionConflict.create({
    data: {
      issue,
      participants: toJson(input.participants),
      positions: toJson(input.positions ?? {}),
      evidence: input.evidence ?? null,
      status,
      taskId: input.taskId ?? null,
      planId: input.planId ?? null,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.DECISION_CONFLICT_RAISED,
    actor: ctx.actor,
    correlationId,
    targetType: "DecisionConflict",
    targetId: row.id,
    companyId: ctx.companyId,
    worldId: ctx.worldId,
    payload: {
      conflictId: row.id,
      subject: row.issue,
      raisedByAgentId: ctx.agentId ?? ctx.actor.actorId ?? "system",
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "conflict.raise",
    targetType: "DecisionConflict",
    targetId: row.id,
    correlationId,
    metadata: { issue: issue.slice(0, 200), status },
  });

  return row;
}

export async function resolveConflict(
  db: DbClient,
  input: ResolveConflictInput,
  ctx: ConflictActorContext,
): Promise<DecisionConflict> {
  const row = await requireConflict(db, input.conflictId);

  if (ConflictStatusSchema.parse(row.status) === "RESOLVED") {
    throw conflictError("Conflict is already resolved", { conflictId: row.id });
  }

  if (ctx.actor.actorType !== "SYSTEM" && ctx.actor.actorType !== "USER") {
    throw forbidden("Only a human or the system may resolve a decision conflict", {
      conflictId: row.id,
    });
  }

  const resolution = input.resolution.trim();
  if (resolution.length < 5) {
    throw validationError("Resolution must state what was decided");
  }
  const decision = input.decision.trim().toUpperCase().slice(0, 50) || "UNSPECIFIED";

  const correlationId = ctx.correlationId ?? newCorrelationId();

  const updated = await db.decisionConflict.update({
    where: { id: row.id },
    data: {
      status: "RESOLVED",
      resolution: `[${decision}] ${resolution}`,
      resolvedAt: new Date(),
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.DECISION_CONFLICT_RESOLVED,
    actor: ctx.actor,
    correlationId,
    targetType: "DecisionConflict",
    targetId: row.id,
    companyId: ctx.companyId,
    worldId: ctx.worldId,
    payload: { conflictId: row.id, resolution: `[${decision}] ${resolution}`, resolvedByAgentId: ctx.agentId ?? null },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "conflict.resolve",
    targetType: "DecisionConflict",
    targetId: row.id,
    correlationId,
    metadata: { decision },
  });

  return updated;
}

export interface ListConflictsQuery {
  status?: string;
  taskId?: string;
  planId?: string;
  take?: number;
}

export async function listConflicts(db: DbClient, query: ListConflictsQuery = {}) {
  return db.decisionConflict.findMany({
    where: {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.taskId !== undefined ? { taskId: query.taskId } : {}),
      ...(query.planId !== undefined ? { planId: query.planId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(query.take ?? 50, 200),
  });
}

export async function requireConflict(db: DbClient, id: string): Promise<DecisionConflict> {
  const row = await db.decisionConflict.findUnique({ where: { id } });
  if (row === null) throw notFound("DecisionConflict", id);
  return row;
}

/** Parsed participants for consumers. */
export function conflictParticipants(row: DecisionConflict): ConflictParticipant[] {
  try {
    const parsed: unknown = JSON.parse(row.participants ?? "[]");
    return Array.isArray(parsed) ? (parsed as ConflictParticipant[]) : [];
  } catch {
    return [];
  }
}


