/**
 * Provider-neutral types.
 *
 * Nothing below this line knows what OpenAI, Anthropic or Google call things.
 * Adapters translate; the agent runtime only ever sees these shapes. Adding a
 * provider means adding one file that returns a `CompletionResult` - no agent
 * code changes, no interface churn.
 */
import type { ToolSpec } from "../../tools/src/types.js";

export type ProviderKind =
  | "OPENAI_COMPATIBLE"
  | "ANTHROPIC"
  | "GOOGLE"
  | "MOCK"
  | "LOCAL";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on `tool` messages: which call this result answers. */
  toolCallId?: string;
  /** Present on `assistant` messages that requested tools. */
  toolCalls?: ToolCall[];
  name?: string;
}

export interface ToolCall {
  /** Provider-supplied id, echoed back with the result. */
  id: string;
  name: string;
  /** Parsed arguments. Adapters are responsible for JSON-parsing; the runtime
   *  still validates against the tool's Zod schema before executing. */
  arguments: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Threaded through for logging and provider-side tracing. */
  correlationId?: string;
  /** Stop sequences, passed through where the provider supports them. */
  stop?: string[];
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface CompletionResult {
  /** Assistant text. May be empty when the model only requested tools. */
  content: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: Usage;
  providerId: string;
  model: string;
  latencyMs: number;
  /** Raw provider response, truncated. Never contains credentials. */
  raw?: unknown;
}

export interface ProviderDescriptor {
  id: string;
  kind: ProviderKind;
  displayName: string;
  /** False when configured but missing an API key, so the dashboard can say
   *  "not configured" instead of "broken". */
  configured: boolean;
  defaultModel: string;
  /** Model ids this provider is known to serve. Advisory only. */
  models: string[];
  notes?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  /** Cheap, side-effect-free readiness probe. */
  isAvailable(): boolean;
  describe(): ProviderDescriptor;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface ProviderOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
}

export function parseToolArguments(
  raw: unknown,
  toolName: string,
): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
      throw new Error("not an object");
    } catch (error) {
      throw new Error(
        `Tool '${toolName}' returned arguments that are not a JSON object: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
  }
  throw new Error(`Tool '${toolName}' returned arguments of unsupported type ${typeof raw}`);
}

export function emptyResult(
  providerId: string,
  model: string,
  content = "",
): CompletionResult {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    providerId,
    model,
    latencyMs: 0,
  };
}
