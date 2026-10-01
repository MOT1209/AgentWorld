import { prisma } from "../../../../packages/database/src/index.js";
import {
  claimForExecution,
  markExecutionFailed,
  markExecutionSucceeded,
  readApprovalPayload,
} from "../../../../packages/approvals/src/index.js";
import { logger, type ActorRef } from "../../../../packages/shared/src/index.js";
import { toolExecutor } from "./composition-root.js";
import { getCorrelationId } from "../middleware/correlation.js";
import type { Request } from "express";
import { getPrincipal } from "../middleware/authenticate.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";

const log = logger.child({ component: "api.approval-replay" });

export async function replayApprovedRequest(
  requestId: string,
  req: Request,
): Promise<{ status: string; toolName: string; data?: unknown; error?: string }> {
  const principal = getPrincipal(req);
  const actor: ActorRef = principalToActor(principal);
  const correlationId = getCorrelationId(req);

  const claimed = await claimForExecution(prisma, requestId);
  if (claimed === null) {
    return { status: "ALREADY_EXECUTED", toolName: "unknown" };
  }

  const payload = readApprovalPayload(claimed);
  log.info("Replaying approved tool", {
    action: "approval.replay",
    targetType: "ApprovalRequest",
    targetId: requestId,
    correlationId,
    toolName: payload.toolName,
  });

  try {
    const result = await toolExecutor.invoke(payload.toolName, payload.arguments, {
      agentId: payload.agentId ?? undefined,
      actor,
      correlationId,
      permissions: principal.permissions,
      db: prisma,
      now: new Date(),
      approvalRequestId: requestId,
      isApprovalReplay: true,
      ...(claimed.companyId !== null ? { companyId: claimed.companyId } : {}),
      ...(claimed.worldId !== null ? { worldId: claimed.worldId } : {}),
    });
    if (result.status === "SUCCESS") {
      await markExecutionSucceeded(prisma, requestId);
    } else {
      await markExecutionFailed(prisma, requestId, result.error ?? result.status);
    }
    return {
      status: result.status,
      toolName: result.toolName,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markExecutionFailed(prisma, requestId, message);
    throw error;
  }
}
