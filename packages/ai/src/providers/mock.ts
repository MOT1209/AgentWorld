/**
 * Deterministic offline provider ("mock").
 *
 * THIS IS NOT AN AI. It is a scripted stand-in that exists so the entire agent
 * loop - tool dispatch, permission checks, approvals, ledger writes, event
 * emission, memory - can be exercised end to end with zero API keys, in CI,
 * and by anyone cloning the repo. Its behaviour is a pure function of the
 * transcript, so the same conversation always produces the same actions.
 *
 * How it works, in one line: it computes an ordered plan of actions from the
 * conversation, then returns the first action that has not already been issued.
 * Because "already issued" is reconstructed from the assistant messages in the
 * transcript, the provider itself is completely stateless and safe to reuse.
 *
 * Configure a real provider to get actual reasoning; the agent runtime is
 * identical either way, which is the point of the abstraction.
 */
import {
  emptyResult,
  type AIProvider,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ProviderDescriptor,
  type ProviderKind,
} from "../types.js";

interface PlannedAction {
  /** Stable identity used to detect that this action was already issued. */
  key: string;
  toolName: string;
  args: Record<string, unknown>;
}

function lastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && message.content.trim() !== "") return message.content.trim();
  }
  return "";
}

function systemContent(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

/** Reconstructs which tool calls have already been made in this transcript. */
function issuedKeys(messages: ChatMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      keys.add(`${call.name}:${JSON.stringify(call.arguments)}`);
    }
  }
  return keys;
}

/** Parsed result of the most recent completed call to `toolName`. */
function lastToolResult(messages: ChatMessage[], toolName: string): Record<string, unknown> | null {
  const results: Record<string, unknown>[] = [];
  const pending = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        pending.set(call.id, call.name);
      }
      continue;
    }
    if (message.role === "tool") {
      const name = message.name ?? pending.get(message.toolCallId ?? "");
      if (name !== toolName) continue;
      try {
        results.push(JSON.parse(message.content) as Record<string, unknown>);
      } catch {
        results.push({ raw: message.content });
      }
    }
  }
  return results.length > 0 ? (results[results.length - 1] ?? null) : null;
}

function shortTitle(goal: string, max = 90): string {
  const firstClause = goal.split(/(?<=[.!?;])\s+/)[0] ?? goal;
  const cleaned = firstClause.trim().replace(/\s+/g, " ");
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}...` : cleaned;
}

/**
 * Splits a goal into two coarse work items. Deliberately crude: a real planner
 * model produces a far better decomposition, and this stub makes no pretence
 * otherwise.
 */
function decompose(goal: string): Array<{ title: string; description: string; priority: string }> {
  const title = shortTitle(goal);
  return [
    {
      title: `Analyse and scope: ${title}`,
      description: `Clarify requirements, identify constraints and risks for: ${goal}`,
      priority: "HIGH",
    },
    {
      title: `Execute and verify: ${title}`,
      description: `Carry out the scoped work and report the outcome for: ${goal}`,
      priority: "MEDIUM",
    },
  ];
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) {
    for (const entry of value) {
      if (typeof entry === "string") return entry;
      if (entry !== null && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const title = record.title ?? record.name ?? record.id;
        if (typeof title === "string") return title;
      }
    }
  }
  return null;
}

function buildPlan(messages: ChatMessage[], availableTools: Set<string>): PlannedAction[] {
  const goal = lastUserContent(messages);
  const system = systemContent(messages);
  const isPlanner = /delegate|plan|break down|analyse|analyze/i.test(system);
  const actions: PlannedAction[] = [];

  const canCreate = availableTools.has("task.create");
  const canList = availableTools.has("task.list");
  const canUpdate = availableTools.has("task.update");
  const canSend = availableTools.has("message.send");

  // -- Planning shape: decompose the goal, then hand off ---------------------
  if (canCreate && goal !== "" && (isPlanner || availableTools.has("task.create"))) {
    const created = lastToolResult(messages, "task.create");
    const alreadyCreated = created !== null;

    if (!alreadyCreated) {
      const steps = decompose(goal);
      steps.forEach((step, index) => {
        actions.push({
          key: `task.create:${index}:${step.title}`,
          toolName: "task.create",
          args: {
            title: step.title,
            description: step.description,
            priority: step.priority,
          },
        });
      });
    } else {
      const taskId = firstString(created.taskId ?? created.id ?? created);
      if (taskId !== null && canSend) {
        actions.push({
          key: `message.send:plan:${taskId}`,
          toolName: "message.send",
          args: {
            to: "EXECUTIVE",
            kind: "PLAN",
            content: `Plan ready for: ${shortTitle(goal)}. Work items have been created (first: ${taskId}). Please execute and report back.`,
            taskId,
          },
        });
      }
    }

    actions.push({
      key: "final:plan",
      toolName: "__final__",
      args: {
        text: alreadyCreated
          ? `Goal understood and broken into work items. I have delegated execution and will review the results.`
          : `Goal understood: ${shortTitle(goal)}. I am creating the work items now.`,
      },
    });
    return actions;
  }

  // -- Execution shape: find work, run it, report it ------------------------
  if (canList && canUpdate) {
    const listed = lastToolResult(messages, "task.list");
    const taskId = listed === null ? null : firstString(listed.taskId ?? listed.items ?? listed.id);

    if (listed === null) {
      actions.push({
        key: "task.list:assigned",
        toolName: "task.list",
        args: { assignedToMe: true, status: "ASSIGNED" },
      });
    } else if (taskId !== null) {
      actions.push({
        key: `task.update:${taskId}:RUNNING`,
        toolName: "task.update",
        args: { taskId, status: "RUNNING" },
      });
      actions.push({
        key: `task.update:${taskId}:COMPLETED`,
        toolName: "task.update",
        args: {
          taskId,
          status: "COMPLETED",
          result: "Executed using the deterministic offline provider. No external provider was configured, so this is a simulated outcome.",
        },
      });
      if (canSend) {
        actions.push({
          key: `message.send:report:${taskId}`,
          toolName: "message.send",
          args: {
            to: "PLANNER",
            kind: "REPORT",
            content: `Task ${taskId} completed. Simulated execution via the offline provider.`,
            taskId,
          },
        });
      }
    }

    actions.push({
      key: "final:execute",
      toolName: "__final__",
      args: {
        text:
          taskId === null
            ? `No assigned work is currently available to me. Standing by.`
            : `Work item ${taskId} processed.`,
      },
    });
    return actions;
  }

  actions.push({
    key: "final:plain",
    toolName: "__final__",
    args: {
      text: goal === ""
        ? "Standing by. No tools are available to me for this request."
        : `Received: ${shortTitle(goal)}. No applicable tools were available for this step.`,
    },
  });
  return actions;
}

export class MockProvider implements AIProvider {
  readonly id: string;
  readonly kind: ProviderKind = "MOCK";
  /** Artificial latency so the dashboard's loading states are exercised. */
  private readonly latencyMs: number;

  constructor(id = "mock", latencyMs = 0) {
    this.id = id;
    this.latencyMs = latencyMs;
  }

  isAvailable(): boolean {
    return true;
  }

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: "Mock (deterministic, offline)",
      configured: true,
      defaultModel: "deterministic-scheduler-v1",
      models: ["deterministic-scheduler-v1"],
      notes:
        "Scripted stand-in for offline development and tests. Produces no real reasoning. Configure a real provider for actual model behaviour.",
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    const availableTools = new Set((request.tools ?? []).map((tool) => tool.name));
    const plan = buildPlan(request.messages, availableTools);
    const issued = issuedKeys(request.messages);

    const next =
      plan.find((action) => !issued.has(action.key)) ??
      plan[plan.length - 1];

    if (next === undefined) {
      return emptyResult(this.id, request.model);
    }

    if (next.toolName === "__final__") {
      return {
        ...emptyResult(this.id, request.model, String(next.args.text ?? "")),
        latencyMs: Date.now() - started,
      };
    }

    return {
      content: "",
      toolCalls: [
        {
          id: `mock_${next.key.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 60)}`,
          name: next.toolName,
          arguments: next.args,
        },
      ],
      finishReason: "tool_calls",
      providerId: this.id,
      model: request.model || "deterministic-scheduler-v1",
      latencyMs: Date.now() - started,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
}
