/**
 * Agent runtime: the think -> act -> observe loop.
 *
 * The loop is provider-agnostic. It knows about roles, tools, memory, tasks and
 * messages; it does not know about OpenAI, Anthropic or any vendor. Swapping an
 * agent's provider is a data change, and nothing in this file moves.
 *
 * Hardening properties of the loop itself:
 *
 *  - The agent has NO database handle and NO service imports. Its only
 *    capability is invoking registered tools through the injected ToolInvoker,
 *    which enforces permissions and approvals. That is what makes "agents
 *    cannot bypass authorization" structurally true.
 *  - Iteration count is bounded, so a confused model cannot loop forever.
 *  - Every turn is persisted: the assistant's text becomes a Message, tool calls
 *    become ToolInvocation rows, and the exchange becomes an agent memory.
 *  - Failure is contained. A provider error or a failing tool ends the run with
 *    a recorded outcome; the agent returns to IDLE or ERROR, never stuck in
 *    THINKING.
 */
import {
  getConfig,
  logger,
  newCorrelationId,
  type ActorRef,
} from "../../shared/src/index.js";
import { prisma, type DbClient } from "../../database/src/index.js";
import type { AgentMemory } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";
import { getProviderRegistry, type ChatMessage, type ToolCall } from "../../ai/src/index.js";
import { retrieveMemories, storeMemory, formatMemoriesForPrompt } from "../../memory/src/index.js";
import { getActiveTask, getTaskDetail } from "../../tasks/src/index.js";
import type { ToolExecutionContext, ToolExecutionResult, ToolSpec } from "../../tools/src/types.js";
import { buildRuntimeProfile, changeAgentState, type AgentRuntimeProfile } from "./agent.service.js";
import { sendMessage } from "./communication.service.js";
import { buildSystemPrompt, buildTurnMessages, MAX_CONTEXT_MESSAGES } from "./prompt-builder.js";

const log = logger.child({ component: "agents.runtime" });

/**
 * Injected so the runtime never imports the tool implementations directly.
 * The composition root wires the real executor; tests wire a stub.
 */
export interface ToolInvoker {
  /** Tool specs the caller is permitted to use. */
  listSpecs(permissions: ReadonlySet<string>, allowedTools: string[] | "*"): ToolSpec[];
  invoke(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export type AgentRunTrigger = "CHAT" | "TASK_ASSIGNED" | "SCHEDULED" | "MANUAL";

export interface AgentRunInput {
  agentId: string;
  trigger: AgentRunTrigger;
  conversationId?: string;
  taskId?: string;
  /** Extra instruction injected as a user turn (e.g. the human's message). */
  userMessage?: string;
  correlationId?: string;
}

export type AgentRunOutcome =
  | "COMPLETED"
  | "FAILED"
  | "AWAITING_APPROVAL"
  | "MAX_ITERATIONS";

export interface AgentRunResult {
  agentId: string;
  outcome: AgentRunOutcome;
  iterations: number;
  providerId: string;
  model: string;
  durationMs: number;
  finalMessage: string | null;
  toolCalls: Array<{
    name: string;
    status: string;
    summary?: string;
    error?: string;
    approvalRequestId?: string;
  }>;
  approvalRequestIds: string[];
  error?: string;
}

export interface RuntimeDeps {
  db?: DbClient;
  invoker: ToolInvoker;
  /** Test seam for the provider registry. */
  providerRegistry?: ReturnType<typeof getProviderRegistry>;
  maxIterationsOverride?: number;
}

export async function runAgent(
  input: AgentRunInput,
  deps: RuntimeDeps,
): Promise<AgentRunResult> {
  const db = deps.db ?? prisma;
  const correlationId = input.correlationId ?? newCorrelationId();
  const started = Date.now();
  const config = getConfig();

  const profile = await buildRuntimeProfile(db, input.agentId);
  const agent = profile.agent;
  const actor: ActorRef = { actorType: "AGENT", actorId: agent.id, actorName: agent.name };

  const registry = deps.providerRegistry ?? getProviderRegistry();
  const provider = registry.require(agent.providerId);

  await changeAgentState(
    db,
    { agentId: agent.id, state: "THINKING", activity: `run:${input.trigger}` },
    { actor, correlationId },
  );

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_RUN_STARTED,
    actor,
    correlationId,
    targetType: "Agent",
    targetId: agent.id,
    worldId: agent.worldId ?? undefined,
    companyId: agent.currentCompanyId ?? undefined,
    payload: {
      agentId: agent.id,
      conversationId: input.conversationId ?? null,
      trigger: input.trigger,
    },
  });

  const tools = deps.invoker.listSpecs(
    new Set(profile.effectivePermissions),
    profile.role.allowedTools,
  );

  const messages = await assembleConversation(db, input, profile, correlationId);

  let outcome: AgentRunOutcome = "MAX_ITERATIONS";
  const toolCalls: AgentRunResult["toolCalls"] = [];
  const approvalRequestIds: string[] = [];
  let finalMessage: string | null = null;
  let iterations = 0;
  let runError: string | undefined;

  const maxIterations = Math.min(
    deps.maxIterationsOverride ?? profile.role.maxIterations,
    config.agent.maxToolIterations * 4,
  );

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      iterations = iteration;

      const completion = await provider.complete({
        model: agent.model,
        messages,
        tools,
        temperature: profile.role.temperature ?? agent.temperature,
        maxTokens: agent.maxTokens,
        timeoutMs: config.agent.requestTimeoutMs,
        correlationId,
      });

      if (completion.content.trim() !== "") {
        finalMessage = completion.content.trim();
      }

      if (completion.toolCalls.length === 0) {
        outcome = "COMPLETED";
        break;
      }

      messages.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls,
      });

      let awaitingApproval = false;

      for (const call of completion.toolCalls) {
        const result = await invokeTool(deps.invoker, call, {
          db,
          agent,
          profile,
          correlationId,
          companyId: agent.currentCompanyId,
          worldId: agent.worldId ?? undefined,
        });

        toolCalls.push({
          name: call.name,
          status: result.status,
          ...(result.summary !== undefined ? { summary: result.summary } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
          ...(result.approvalRequestId !== undefined
            ? { approvalRequestId: result.approvalRequestId }
            : {}),
        });

        if (result.approvalRequestId !== undefined) {
          approvalRequestIds.push(result.approvalRequestId);
        }
        if (result.status === "PENDING_APPROVAL") awaitingApproval = true;

        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: serializeToolResult(result),
        });

        if (result.status === "DENIED") {
          await changeAgentState(
            db,
            {
              agentId: agent.id,
              state: "WAITING",
              activity: `tool_denied:${call.name}`,
              reason: result.error ?? "permission denied",
            },
            { actor, correlationId },
          );
        }
      }

      if (awaitingApproval) {
        // Stop here rather than letting the model talk itself past a gate.
        // The turn resumes when a human approves.
        outcome = "AWAITING_APPROVAL";
        break;
      }
    }

    if (iterations >= maxIterations && outcome === "MAX_ITERATIONS") {
      finalMessage =
        finalMessage ??
        `Stopped after ${maxIterations} iterations without reaching a conclusion.`;
    }
  } catch (error) {
    outcome = "FAILED";
    runError = error instanceof Error ? error.message : String(error);
    log.error("Agent run failed", {
      action: "agent.run",
      targetType: "Agent",
      targetId: agent.id,
      result: "ERROR",
      actorType: "AGENT",
      actorId: agent.id,
      error,
      correlationId,
    });

    await changeAgentState(
      db,
      { agentId: agent.id, state: "ERROR", activity: "run_failed", reason: runError },
      { actor, correlationId },
    );
  }

  // Persist the assistant's reply so the human sees it in the timeline.
  if (input.conversationId !== undefined && finalMessage !== null && outcome !== "FAILED") {
    await sendMessage(
      db,
      {
        conversationId: input.conversationId,
        content: finalMessage,
        senderType: "AGENT",
        senderAgentId: agent.id,
        kind: toolCalls.length > 0 ? "REPORT" : "MESSAGE",
        correlationId,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        metadata: {
          providerId: provider.id,
          model: agent.model,
          outcome,
          iterations,
          toolCallCount: toolCalls.length,
          approvalRequestIds,
        },
      },
      { actor, correlationId },
    );
  }

  // Remember the exchange so the next turn has continuity.
  if (outcome !== "FAILED" && (finalMessage !== null || toolCalls.length > 0)) {
    await persistRunMemory(db, profile, input, toolCalls, finalMessage, actor, correlationId);
  }

  if (outcome !== "FAILED") {
    const restingState = outcome === "AWAITING_APPROVAL" ? "WAITING" : "IDLE";
    await changeAgentState(
      db,
      {
        agentId: agent.id,
        state: restingState,
        activity: outcome === "AWAITING_APPROVAL" ? "awaiting_approval" : "idle",
        ...(outcome === "AWAITING_APPROVAL" ? { currentTaskId: null } : {}),
      },
      { actor, correlationId },
    );
  }

  const durationMs = Date.now() - started;

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_RUN_FINISHED,
    actor,
    correlationId,
    targetType: "Agent",
    targetId: agent.id,
    worldId: agent.worldId ?? undefined,
    companyId: agent.currentCompanyId ?? undefined,
    payload: {
      agentId: agent.id,
      iterations,
      toolCalls: toolCalls.length,
      durationMs,
      outcome: outcome === "MAX_ITERATIONS" ? "FAILED" : outcome,
    },
  });

  await recordActivity(db, {
    actor,
    action: "agent.run",
    targetType: "Agent",
    targetId: agent.id,
    result: outcome === "FAILED" ? "ERROR" : "OK",
    correlationId,
    error: runError ?? null,
    metadata: {
      trigger: input.trigger,
      outcome,
      iterations,
      toolCallCount: toolCalls.length,
      providerId: provider.id,
      model: agent.model,
      durationMs,
      approvalRequestIds,
    },
  });

  return {
    agentId: agent.id,
    outcome,
    iterations,
    providerId: provider.id,
    model: agent.model,
    durationMs,
    finalMessage,
    toolCalls,
    approvalRequestIds,
    ...(runError !== undefined ? { error: runError } : {}),
  };
}

async function invokeTool(
  invoker: ToolInvoker,
  call: ToolCall,
  context: {
    db: DbClient;
    agent: AgentRuntimeProfile["agent"];
    profile: AgentRuntimeProfile;
    correlationId: string;
    companyId: string | null;
    worldId: string | undefined;
  },
): Promise<ToolExecutionResult> {
  const toolContext: ToolExecutionContext = {
    agentId: context.agent.id,
    actor: { actorType: "AGENT", actorId: context.agent.id, actorName: context.agent.name },
    correlationId: context.correlationId,
    permissions: new Set(context.profile.effectivePermissions),
    db: context.db,
    now: new Date(),
    ...(context.companyId !== null ? { companyId: context.companyId } : {}),
    ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
  };

  try {
    return await invoker.invoke(call.name, call.arguments, toolContext);
  } catch (error) {
    // A tool that throws is a tool failure, not a run failure: report it to the
    // model so it can adapt rather than aborting the whole turn.
    return {
      status: "ERROR",
      toolName: call.name,
      error: error instanceof Error ? error.message : String(error),
      durationMs: 0,
    };
  }
}

/** Tool results are fed back to the model as plain text, so keep them compact. */
function serializeToolResult(result: ToolExecutionResult): string {
  if (result.status === "PENDING_APPROVAL") {
    return JSON.stringify({
      status: result.status,
      approvalRequestId: result.approvalRequestId,
      message:
        "This action requires human approval and has been withheld. Tell the requester what you need approved and stop working on it.",
    });
  }
  if (result.status === "DENIED") {
    return JSON.stringify({
      status: result.status,
      error: result.error ?? "Permission denied",
      message: "You do not have permission for this action. Do not attempt to work around it.",
    });
  }
  if (result.status === "ERROR") {
    return JSON.stringify({ status: result.status, error: result.error ?? "Unknown error" });
  }
  return JSON.stringify({ status: "SUCCESS", result: result.data ?? null });
}

async function assembleConversation(
  db: DbClient,
  input: AgentRunInput,
  profile: AgentRuntimeProfile,
  correlationId: string,
): Promise<ChatMessage[]> {
  const agent = profile.agent;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(profile) },
  ];

  // Relevant memories, excluding the conversation being replayed.
  const memories = await retrieveMemories(db, {
    agentId: agent.id,
    limit: 8,
    ...(input.conversationId !== undefined
      ? { excludeConversationId: input.conversationId }
      : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
  });
  if (memories.length > 0) {
    messages.push({
      role: "system",
      content: `Relevant memories:\n${formatMemoriesForPrompt(memories)}`,
    });
  }

  // Current work context.
  const task = input.taskId !== undefined ? await loadTask(db, input.taskId) : await getActiveTask(db, agent.id);
  const situational = await buildTurnMessages(db, {
    profile,
    taskId: task?.id,
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    ...(input.userMessage !== undefined ? { userMessage: input.userMessage } : {}),
  });
  messages.push(...situational);

  void correlationId;
  return messages;
}

async function loadTask(db: DbClient, taskId: string) {
  const detail = await getTaskDetail(db, taskId).catch(() => null);
  return detail?.task ?? null;
}

async function persistRunMemory(
  db: DbClient,
  profile: AgentRuntimeProfile,
  input: AgentRunInput,
  toolCalls: AgentRunResult["toolCalls"],
  finalMessage: string | null,
  actor: ActorRef,
  correlationId: string,
): Promise<void> {
  const agent = profile.agent;
  const memoryContext = { actor, correlationId };

  // Episodic: what happened in this run.
  const episode =
    `Run (${input.trigger}) using ${profile.agent.providerId}/${profile.agent.model}. ` +
    `Tools used: ${toolCalls.map((call) => `${call.name}:${call.status}`).join(", ") || "none"}. ` +
    `Outcome: ${finalMessage !== null ? finalMessage.slice(0, 500) : "(no reply)"}`;
  await storeMemory(
    db,
    {
      agentId: agent.id,
      kind: "EPISODIC",
      content: episode,
      importance: toolCalls.length > 0 ? 6 : 4,
      source: "CONVERSATION",
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    },
    memoryContext,
  );

  // Fact: what the agent concluded, when it concluded something.
  if (finalMessage !== null && finalMessage.trim().length > 20) {
    await storeMemory(
      db,
      {
        agentId: agent.id,
        kind: "FACT",
        content: finalMessage.trim().slice(0, 1_000),
        importance: 7,
        source: "CONVERSATION",
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      },
      memoryContext,
    );
  }

  // Short-term: the outstanding obligations.
  const pending = toolCalls.filter((call) => call.status === "PENDING_APPROVAL");
  if (pending.length > 0) {
    await storeMemory(
      db,
      {
        agentId: agent.id,
        kind: "SHORT_TERM",
        content: `Awaiting human approval for: ${pending
          .map((call) => `${call.name} (request ${call.approvalRequestId ?? "unknown"})`)
          .join(", ")}. Do not retry these until a decision arrives.`,
        importance: 9,
        source: "SYSTEM",
      },
      memoryContext,
    );
  }
}

export type { AgentMemory, AgentRuntimeProfile, MAX_CONTEXT_MESSAGES };
