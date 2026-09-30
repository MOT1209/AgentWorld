/**
 * Audit trail.
 *
 * Distinct from EventLog on purpose:
 *
 *   EventLog     - domain facts, emitted by services as a natural consequence
 *                  of doing the work. Append-only, high volume.
 *   ActivityLog  - "who did what to which target, and did it succeed". Written
 *                  for every state-changing API call and every tool execution,
 *                  including denials. This is the table the operator timeline
 *                  in the dashboard reads.
 *
 * Denials are recorded as carefully as successes. An audit trail that only
 * captures what worked is not an audit trail.
 */
import { toJson, newCorrelationId, type ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { ActivityLog } from "../../database/src/types.js";

export interface ActivityInput {
  actor: ActorRef;
  action: string;
  targetType?: string;
  targetId?: string;
  result?: "OK" | "ERROR";
  error?: string | null;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  userId?: string | null;
}

export async function recordActivity(
  db: DbClient,
  input: ActivityInput,
): Promise<ActivityLog> {
  return db.activityLog.create({
    data: {
      actorType: input.actor.actorType,
      actorId: input.actor.actorId ?? null,
      actorName: input.actor.actorName ?? "unknown",
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      result: input.result ?? "OK",
      error: input.error ?? null,
      correlationId: input.correlationId ?? newCorrelationId(),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      actorUserId: input.userId ?? null,
      metadata: toJson(input.metadata ?? {}),
    },
  });
}

export interface ActivityQuery {
  actorId?: string;
  action?: string;
  correlationId?: string;
  take?: number;
  skip?: number;
}

export async function listActivity(db: DbClient, query: ActivityQuery = {}) {
  return db.activityLog.findMany({
    where: {
      ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.correlationId !== undefined ? { correlationId: query.correlationId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: query.take ?? 50,
    skip: query.skip ?? 0,
  });
}
