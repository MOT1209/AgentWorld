import type { Request } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { runAgent, type AgentRunInput, type AgentRunResult } from "../../../../packages/agents/src/runtime.js";
import { invoker, getCompositionRoot } from "./composition-root.js";
import { getCorrelationId } from "../middleware/correlation.js";
import {
  appendSessionToolCall,
  finishSession,
  startSession,
  transitionSession,
} from "../../../../packages/runtime/src/index.js";
import { actorSystem, type ActorRef } from "../../../../packages/shared/src/actor.js";
import { logger } from "../../../../packages/shared/src/index.js";

const log = logger.child({ component: "api.orchestrator" });
const SYSTEM: ActorRef = actorSystem("orchestrator");

/**
 * Runs an agent with a session observability record wrapped around it.
 *
 * The session is bookkeeping, not control: a session failure never masks or
 * replaces the run result (H-2). Flow:
 *   INITIALIZING (open) -> RUNNING -> per-tool appends ->
 *   COMPLETED | FAILED | CANCELLED (finish) | WAITING (still open, resumes
 *   after the human decides the pending approval).
 */
export async function orchestrateAgentRun(
  input: Omit<AgentRunInput, "correlationId">,
  req: Request,
): Promise<AgentRunResult> {
  const correlationId = getCorrelationId(req);
  const { providerRegistry } = getCompositionRoot();

  const session = await startSession(
    prisma,
    {
      agentId: input.agentId,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      trigger: input.trigger,
      context: {
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(input.userMessage !== undefined ? { userMessage: input.userMessage.slice(0, 500) } : {}),
      },
    },
    { actor: SYSTEM, correlationId },
  );

  let result: AgentRunResult;
  try {
    await transitionSession(prisma, session.id, "RUNNING", { actor: SYSTEM, correlationId });
    result = await runAgent({ ...input, correlationId }, { db: prisma, invoker, providerRegistry });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSession(prisma, session.id, { status: "FAILED", error: message }, { actor: SYSTEM, correlationId });
    throw error;
  }

  for (const call of result.toolCalls) {
    try {
      await appendSessionToolCall(
        prisma,
        session.id,
        {
          name: call.name,
          status: call.status,
          ...(call.approvalRequestId !== undefined ? { approvalRequestId: call.approvalRequestId } : {}),
        },
        { actor: SYSTEM, correlationId },
      );
    } catch (error) {
      // Tool-call bookkeeping must not fail a completed run; it is loud.
      log.warn("Failed to append session tool call", {
        action: "session.append_tool_call",
        targetType: "AgentSession",
        targetId: session.id,
        correlationId,
        error,
      });
    }
  }

  if (result.outcome === "AWAITING_APPROVAL") {
    await transitionSession(prisma, session.id, "WAITING", { actor: SYSTEM, correlationId });
    return result;
  }

  await finishSession(
    prisma,
    session.id,
    {
      status: result.outcome === "COMPLETED" ? "COMPLETED" : "FAILED",
      ...(result.finalMessage != null ? { result: result.finalMessage.slice(0, 2000) } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    },
    { actor: SYSTEM, correlationId },
  );
  return result;
}
