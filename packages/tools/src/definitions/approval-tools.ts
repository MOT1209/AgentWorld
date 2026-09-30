/**
 * Approval tools.
 *
 * Note what is NOT here: there is no `approval.decide` tool available to agents.
 * That is the single most important omission in the tool catalogue. Approvals
 * are resolved exclusively by an authenticated human through the HTTP API, so
 * an agent has no mechanism - not a hidden one, not a permission-gated one -
 * by which to approve its own spending or its own agent creation.
 *
 * `approval.decide` exists as a HUMAN-ONLY tool so the registry's humanOnly
 * gate is exercised by real code and real tests rather than being an untested
 * branch.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import {
  decideApproval,
  getApproval,
  listApprovals,
  readApprovalPayload,
} from "../../../approvals/src/index.js";
import type { ApprovalStatus } from "../../../shared/src/index.js";
import { notFound, validationError } from "../../../shared/src/index.js";
import type { ToolDefinition } from "../types.js";

export const approvalListTool: ToolDefinition<{
  status?: ApprovalStatus;
  requesterAgentId?: string;
  limit?: number;
}> = {
  name: "approval.list",
  description:
    "List approval requests. An agent may list the requests it raised so it can tell the human " +
    "what it is waiting for.",
  inputSchema: z.object({
    status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]).optional(),
    requesterAgentId: z
      .string()
      .optional()
      .describe("Defaults to your own requests. Ignored for human callers."),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  requiredPermission: PERMISSIONS.APPROVAL_READ,
  risk: "LOW",
  async execute(context, input) {
    // An agent may only ever see its own requests, whatever it asks for.
    const requesterAgentId =
      context.agentId !== undefined ? context.agentId : input.requesterAgentId;

    const requests = await listApprovals(context.db, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(requesterAgentId !== undefined ? { requesterAgentId } : {}),
      take: input.limit,
    });

    return {
      data: {
        requests: requests.map((request) => ({
          id: request.id,
          action: request.action,
          status: request.status,
          risk: request.risk,
          reason: request.reason,
          createdAt: request.createdAt,
          expiresAt: request.expiresAt,
        })),
      },
      summary: `${requests.length} approval request(s)`,
    };
  },
};

export const approvalGetTool: ToolDefinition<{ approvalRequestId: string }> = {
  name: "approval.get",
  description:
    "Read one approval request in full, including the exact action that is being withheld. " +
    "An agent may only read a request it raised.",
  inputSchema: z.object({
    approvalRequestId: z.string(),
  }),
  requiredPermission: PERMISSIONS.APPROVAL_READ,
  risk: "LOW",
  async execute(context, input) {
    const request = await getApproval(context.db, input.approvalRequestId);

    if (context.agentId !== undefined && request.requesterAgentId !== context.agentId) {
      throw notFound("ApprovalRequest", input.approvalRequestId);
    }

    const payload = readApprovalPayload(request);
    return {
      data: {
        id: request.id,
        action: request.action,
        status: request.status,
        risk: request.risk,
        reason: request.reason,
        toolName: payload.toolName,
        arguments: payload.arguments,
        decidedAt: request.decidedAt,
        decisionNote: request.decisionNote,
      },
      summary: `Approval ${request.id}: ${request.action} is ${request.status}`,
    };
  },
};

export const approvalDecideTool: ToolDefinition<{
  approvalRequestId: string;
  decision: "APPROVED" | "REJECTED";
  note?: string;
}> = {
  name: "approval.decide",
  description:
    "Human-only. Approve or reject a pending request. Approving releases the exact action that was " +
    "withheld; the system executes it once, automatically.",
  inputSchema: z.object({
    approvalRequestId: z.string(),
    decision: z.enum(["APPROVED", "REJECTED"]),
    note: z.string().max(1_000).optional().describe("Why. Recorded in the audit trail."),
  }),
  requiredPermission: PERMISSIONS.APPROVAL_DECIDE,
  risk: "CRITICAL",
  humanOnly: true,
  async execute(context, input) {
    if (context.actor.actorType !== "USER") {
      throw validationError("Only a human may decide an approval");
    }
    const decidedByUserId = context.actor.actorId;
    if (decidedByUserId === undefined) {
      throw validationError("Deciding an approval requires an authenticated human");
    }

    const updated = await decideApproval(
      context.db,
      {
        requestId: input.approvalRequestId,
        decision: input.decision,
        ...(input.note !== undefined ? { note: input.note } : {}),
        decidedByUserId,
        ...(context.actor.actorName !== undefined ? { decidedByName: context.actor.actorName } : {}),
      },
      {
        actor: context.actor,
        correlationId: context.correlationId,
        permissions: context.permissions,
        userId: decidedByUserId,
      },
    );

    return {
      data: { id: updated.id, status: updated.status, decidedAt: updated.decidedAt },
      summary: `Approval ${updated.id} ${updated.status.toLowerCase()}`,
    };
  },
};

export const approvalTools = [approvalListTool, approvalGetTool, approvalDecideTool];
