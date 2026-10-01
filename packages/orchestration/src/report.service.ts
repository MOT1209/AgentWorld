/**
 * Report service.
 *
 * Reports are the *pull* half of the protocol: escalations interrupt, reports
 * inform. Every report is authored (an agent or a human), attributed to
 * whatever it describes (task, plan, conversation), and immutably logged in
 * the event stream -- the review layer reads them, it never edits them.
 */
import {
  ReportKindSchema,
  forbidden,
  newCorrelationId,
  notFound,
  validationError,
} from "../../shared/src/index.js";
import type { ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Report } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";
import { toJson } from "../../shared/src/json.js";

export interface ReportActorContext {
  actor: ActorRef;
  /** Absent means SYSTEM: unrestricted internal use. */
  permissions?: ReadonlySet<Permission>;
  agentId?: string;
  userId?: string;
  correlationId?: string;
  companyId?: string;
  worldId?: string;
}

export interface WriteReportInput {
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
  taskId?: string | null;
  planId?: string | null;
  conversationId?: string | null;
}

function has(ctx: ReportActorContext, permission: Permission): boolean {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.permissions === undefined) return true;
  return ctx.permissions.has(permission);
}

export async function writeReport(
  db: DbClient,
  input: WriteReportInput,
  ctx: ReportActorContext,
): Promise<Report> {
  if (!has(ctx, PERMISSIONS.REPORT_CREATE)) {
    throw forbidden("Caller lacks 'report.create'");
  }

  const kind = ReportKindSchema.parse(input.kind);
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (summary.length === 0) {
    throw validationError("A report needs a summary");
  }
  if (summary.length > 2000) {
    throw validationError("Report summary is limited to 2000 characters");
  }

  if (input.taskId != null) {
    const task = await db.task.findUnique({
      where: { id: input.taskId },
      select: { id: true },
    });
    if (task === null) throw notFound("Task", input.taskId);
  }
  if (input.planId != null) {
    const plan = await db.plan.findUnique({
      where: { id: input.planId },
      select: { id: true },
    });
    if (plan === null) throw notFound("Plan", input.planId);
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();

  const report = await db.report.create({
    data: {
      kind,
      summary,
      payload: toJson(input.payload ?? {}),
      taskId: input.taskId ?? null,
      planId: input.planId ?? null,
      conversationId: input.conversationId ?? null,
      authorAgentId: ctx.agentId ?? null,
      authorUserId: ctx.userId ?? null,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.REPORT_WRITTEN,
    actor: ctx.actor,
    correlationId,
    targetType: "Report",
    targetId: report.id,
    companyId: ctx.companyId,
    worldId: ctx.worldId,
    payload: {
      reportId: report.id,
      taskId: report.taskId,
      kind,
      authorAgentId: report.authorAgentId,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "report.write",
    targetType: "Report",
    targetId: report.id,
    correlationId,
    metadata: { kind, taskId: report.taskId ?? null, planId: report.planId ?? null },
  });

  return report;
}

export interface ListReportsQuery {
  kind?: string;
  taskId?: string;
  planId?: string;
  authorAgentId?: string;
  skip?: number;
  take?: number;
}

export async function listReports(db: DbClient, query: ListReportsQuery = {}) {
  return db.report.findMany({
    where: {
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.taskId !== undefined ? { taskId: query.taskId } : {}),
      ...(query.planId !== undefined ? { planId: query.planId } : {}),
      ...(query.authorAgentId !== undefined ? { authorAgentId: query.authorAgentId } : {}),
    },
    orderBy: { createdAt: "desc" },
    skip: query.skip ?? 0,
    take: Math.min(query.take ?? 50, 200),
  });
}

export async function getReport(db: DbClient, reportId: string): Promise<Report> {
  const report = await db.report.findUnique({ where: { id: reportId } });
  if (report === null) throw notFound("Report", reportId);
  return report;
}

/** Decoded payload for consumers; reports are immutable so this never mutates. */
export function reportPayload(report: Report): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(report.payload ?? "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}



