/**
 * Approval service.
 *
 * An approval request freezes an exact action - tool name plus validated
 * arguments - and a human later releases it. Design decisions worth stating:
 *
 *  1. THE PAYLOAD IS IMMUTABLE. A request stores the arguments that were
 *     withheld. When the human approves, those exact arguments are executed.
 *     Nothing re-derives them at approval time, so an agent cannot change its
 *     mind between asking and receiving.
 *  2. EXECUTION IS SINGLE-FLIGHT. `claimForExecution` flips `executedAt` only
 *     if it is null. Two concurrent approve calls cannot execute the same
 *     money movement twice.
 *  3. AGENTS CANNOT DECIDE. The decide path requires a human principal holding
 *     `approval.decide`. There is no agent-callable tool that resolves a
 *     request, by construction - the tool registry simply has none.
 */
import {
  ApprovalStatusSchema,
  addHours,
  newCorrelationId,
  toJson,
  validationError,
  type ActorRef,
  type ApprovalStatus,
  type RiskLevel,
} from "../../shared/src/index.js";
import { conflict, forbidden, notFound } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { ApprovalRequest } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";
import { evaluateApproval, loadApprovalPolicy, type ApprovalPolicy } from "./approval-policy.js";

export interface ApprovalContext {
  actor: ActorRef;
  correlationId?: string;
  permissions?: ReadonlySet<Permission>;
  userId?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface RequestApprovalInput {
  action: string;
  actionPayload: unknown;
  reason: string;
  risk: RiskLevel;
  requester: ActorRef;
  requesterAgentId?: string | null;
  companyId?: string | null;
  worldId?: string | null;
  taskId?: string | null;
  /** Tool that produced this request, so the executor can replay it. */
  toolName?: string;
  /** Agent whose tool invocation is being held. */
  agentId?: string | null;
  ttlHours?: number;
}

export async function requestApproval(
  db: DbClient,
  input: RequestApprovalInput,
  ctx: ApprovalContext,
): Promise<ApprovalRequest> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const policy = loadApprovalPolicy();
  const ttlHours = input.ttlHours ?? policy.ttlHours;

  const request = await db.approvalRequest.create({
    data: {
      requesterType: input.requester.actorType,
      requesterAgentId: input.requesterAgentId ?? input.requester.actorId ?? null,
      requesterUserId: input.requester.actorType === "USER" ? (input.requester.actorId ?? null) : null,
      action: input.action,
      actionPayload: toJson({
        toolName: input.toolName ?? input.action,
        agentId: input.agentId ?? input.requester.actorId ?? null,
        arguments: input.actionPayload,
      }),
      reason: input.reason,
      risk: input.risk,
      status: "PENDING",
      companyId: input.companyId ?? null,
      worldId: input.worldId ?? null,
      taskId: input.taskId ?? null,
      expiresAt: addHours(new Date(), ttlHours),
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.APPROVAL_REQUESTED,
    actor: input.requester,
    correlationId,
    targetType: "ApprovalRequest",
    targetId: request.id,
    companyId: input.companyId ?? undefined,
    worldId: input.worldId ?? undefined,
    payload: {
      approvalRequestId: request.id,
      action: input.action,
      risk: input.risk,
      requesterAgentId: request.requesterAgentId,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "approval.request",
    targetType: "ApprovalRequest",
    targetId: request.id,
    correlationId,
    userId: ctx.userId,
    metadata: { action: input.action, risk: input.risk, toolName: input.toolName ?? null },
  });

  return request;
}

export interface DecideInput {
  requestId: string;
  decision: "APPROVED" | "REJECTED";
  note?: string;
  decidedByUserId: string;
  decidedByName?: string;
}

export async function decideApproval(
  db: DbClient,
  input: DecideInput,
  ctx: ApprovalContext,
): Promise<ApprovalRequest> {
  assertCanDecide(ctx);

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const request = await db.approvalRequest.findUnique({ where: { id: input.requestId } });
  if (request === null) throw notFound("ApprovalRequest", input.requestId);

  if (request.status !== "PENDING") {
    throw conflict(`Approval request is already ${request.status}`, {
      requestId: request.id,
      status: request.status,
    });
  }
  if (request.expiresAt !== null && request.expiresAt.getTime() <= Date.now()) {
    await expireRequest(db, request, correlationId);
    throw conflict("Approval request has expired", { requestId: request.id });
  }

  const updated = await db.approvalRequest.update({
    where: { id: request.id },
    data: {
      status: input.decision,
      decidedByUserId: input.decidedByUserId,
      decidedAt: new Date(),
      decisionNote: input.note ?? null,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type:
      input.decision === "APPROVED"
        ? EVENT_TYPES.APPROVAL_GRANTED
        : EVENT_TYPES.APPROVAL_REJECTED,
    actor: ctx.actor,
    correlationId,
    targetType: "ApprovalRequest",
    targetId: request.id,
    companyId: request.companyId ?? undefined,
    payload: {
      approvalRequestId: request.id,
      action: request.action,
      decidedByUserId: input.decidedByUserId,
    },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: `approval.${input.decision === "APPROVED" ? "approve" : "reject"}`,
    targetType: "ApprovalRequest",
    targetId: request.id,
    correlationId,
    userId: input.decidedByUserId,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    metadata: { action: request.action, risk: request.risk, note: input.note ?? null },
  });

  return updated;
}

/**
 * Atomically reserves a pending, approved request for execution.
 * Returns false if another caller already claimed it or it is not executable.
 */
export async function claimForExecution(
  db: DbClient,
  requestId: string,
): Promise<ApprovalRequest | null> {
  const result = await db.approvalRequest.updateMany({
    where: { id: requestId, status: "APPROVED", executedAt: null },
    data: { executedAt: new Date() },
  });
  if (result.count === 0) return null;
  return db.approvalRequest.findUnique({ where: { id: requestId } });
}

export async function markExecutionFailed(
  db: DbClient,
  requestId: string,
  error: string,
): Promise<void> {
  await db.approvalRequest.update({
    where: { id: requestId },
    data: {
      executionError: error.slice(0, 2_000),
      // Release the claim so a human can retry after fixing the underlying issue.
      executedAt: null,
    },
  });
}

/**
 * The handler failed after it started, so effects may have partly happened.
 * The claim is KEPT: re-running a non-idempotent action (a transfer, a
 * publish) could duplicate it. A human must inspect and file a new request.
 */
export async function markExecutionUncertain(
  db: DbClient,
  requestId: string,
  error: string,
): Promise<void> {
  await db.approvalRequest.update({
    where: { id: requestId },
    data: {
      executionError: `Execution may have partially completed; not retryable. ${error}`.slice(0, 2_000),
    },
  });
}

export async function markExecutionSucceeded(db: DbClient, requestId: string): Promise<void> {
  await db.approvalRequest.update({
    where: { id: requestId },
    data: { executedAt: new Date(), executionError: null },
  });
}

export interface StoredApprovalPayload {
  toolName: string;
  agentId: string | null;
  arguments: Record<string, unknown>;
}

export function readApprovalPayload(request: ApprovalRequest): StoredApprovalPayload {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(request.actionPayload) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    toolName: typeof parsed.toolName === "string" ? parsed.toolName : request.action,
    agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
    arguments:
      parsed.arguments !== null && typeof parsed.arguments === "object"
        ? (parsed.arguments as Record<string, unknown>)
        : {},
  };
}

export interface ListApprovalsQuery {
  status?: ApprovalStatus | ApprovalStatus[];
  requesterAgentId?: string;
  companyId?: string;
  risk?: RiskLevel;
  skip?: number;
  take?: number;
}

export async function listApprovals(db: DbClient, query: ListApprovalsQuery = {}) {
  const statuses =
    query.status === undefined
      ? undefined
      : Array.isArray(query.status)
        ? query.status
        : [query.status];

  return db.approvalRequest.findMany({
    where: {
      ...(statuses !== undefined ? { status: { in: statuses } } : {}),
      ...(query.requesterAgentId !== undefined ? { requesterAgentId: query.requesterAgentId } : {}),
      ...(query.companyId !== undefined ? { companyId: query.companyId } : {}),
      ...(query.risk !== undefined ? { risk: query.risk } : {}),
    },
    orderBy: { createdAt: "desc" },
    skip: query.skip ?? 0,
    take: Math.min(query.take ?? 50, 200),
  });
}

export async function getApproval(db: DbClient, requestId: string): Promise<ApprovalRequest> {
  const request = await db.approvalRequest.findUnique({ where: { id: requestId } });
  if (request === null) throw notFound("ApprovalRequest", requestId);
  return request;
}

export async function countPendingApprovals(db: DbClient, companyId?: string): Promise<number> {
  return db.approvalRequest.count({
    where: {
      status: "PENDING",
      ...(companyId !== undefined ? { companyId } : {}),
    },
  });
}

/** Expires stale requests. Idempotent; safe to call from a heartbeat. */
export async function expireStaleApprovals(
  db: DbClient,
  now: Date = new Date(),
): Promise<number> {
  const stale = await db.approvalRequest.findMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    select: { id: true, action: true },
  });

  for (const entry of stale) {
    await db.approvalRequest.update({
      where: { id: entry.id },
      data: { status: "EXPIRED", decidedAt: now },
    });
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.APPROVAL_EXPIRED,
      actor: { actorType: "SYSTEM", actorName: "approval-expiry" },
      correlationId: newCorrelationId(),
      targetType: "ApprovalRequest",
      targetId: entry.id,
      payload: { approvalRequestId: entry.id, action: entry.action },
    });
  }

  return stale.length;
}

async function expireRequest(
  db: DbClient,
  request: ApprovalRequest,
  correlationId: string,
): Promise<void> {
  await db.approvalRequest.update({
    where: { id: request.id },
    data: { status: "EXPIRED", decidedAt: new Date() },
  });
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.APPROVAL_EXPIRED,
    actor: { actorType: "SYSTEM", actorName: "approval-expiry" },
    correlationId,
    targetType: "ApprovalRequest",
    targetId: request.id,
    payload: { approvalRequestId: request.id, action: request.action },
  });
}

/** Convenience wrapper used by the tool executor. */
export function shouldRequireApproval(input: {
  action: string;
  declaredRisk: RiskLevel;
  amountMinor?: number;
  policy?: ApprovalPolicy;
}): { risk: RiskLevel; reason: string } | null {
  return evaluateApproval(input);
}

export function parseApprovalStatus(value: string): ApprovalStatus {
  return ApprovalStatusSchema.parse(value);
}

function assertCanDecide(ctx: ApprovalContext): void {
  if (ctx.actor.actorType === "SYSTEM") return;
  if (ctx.permissions === undefined) return;
  if (!ctx.permissions.has(PERMISSIONS.APPROVAL_DECIDE)) {
    throw forbidden("Deciding an approval requires 'approval.decide'");
  }
}

export function assertReasonPresent(reason: string): void {
  if (typeof reason !== "string" || reason.trim().length < 5) {
    throw validationError("An approval request must include a meaningful reason");
  }
}
