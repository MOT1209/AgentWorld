/**
 * Anthropic-compatible provider.
 *
 * Anthropic's Messages API differs structurally from OpenAI's: `system` is a
 * top-level parameter rather than a message, and tool results are `tool_result`
 * blocks inside a single user message. Both differences are contained here; no
 * caller ever assembles Anthropic-shaped payloads by hand.
 */
import { aiProviderError, getConfig } from "../../../shared/src/index.js";
import { postJson } from "../http.js";
import {
  parseToolArguments,
  type AIProvider,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ProviderDescriptor,
  type ProviderKind,
  type ProviderOptions,
} from "../types.js";

interface AnthropicResponse {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: unknown;
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      };
      const last = converted[converted.length - 1];
      if (last !== undefined && last.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        converted.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      converted.push({ role: "assistant", content: blocks });
      continue;
    }

    converted.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: converted,
  };
}

const STOP_REASON_MAP: Record<string, CompletionResult["finishReason"]> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

export class AnthropicCompatibleProvider implements AIProvider {
  readonly id: string;
  readonly kind: ProviderKind = "ANTHROPIC";
  private readonly options: ProviderOptions;
  private readonly apiVersion: string;

  constructor(id: string, options: ProviderOptions, apiVersion = "2023-06-01") {
    this.id = id;
    this.options = options;
    this.apiVersion = apiVersion;
  }

  isAvailable(): boolean {
    return this.options.apiKey !== "";
  }

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: "Anthropic-compatible",
      configured: this.isAvailable(),
      defaultModel: this.options.defaultModel,
      models: [],
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.isAvailable()) {
      throw aiProviderError(`Provider '${this.id}' is not configured.`);
    }
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
    const { system, messages } = toAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model || this.options.defaultModel,
      max_tokens: request.maxTokens ?? 2048,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(request.stop && request.stop.length > 0 ? { stop_sequences: request.stop } : {}),
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const { data, latencyMs } = await postJson<AnthropicResponse>({
      url: `${this.options.baseUrl.replace(/\/$/, "")}/messages`,
      headers: {
        "x-api-key": this.options.apiKey,
        "anthropic-version": this.apiVersion,
        ...(this.options.extraHeaders ?? {}),
      },
      body,
      timeoutMs,
      providerId: this.id,
      ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
    });

    if (data.error?.message !== undefined) {
      throw aiProviderError(`Provider '${this.id}' returned an error`, data.error.message);
    }

    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    const toolCalls = (data.content ?? [])
      .filter((block) => block.type === "tool_use")
      .map((block, index) => ({
        id: block.id ?? `call_${index}`,
        name: block.name ?? "unknown",
        arguments: parseToolArguments(block.input ?? {}, block.name ?? "unknown"),
      }));

    return {
      content: text,
      toolCalls,
      finishReason: STOP_REASON_MAP[data.stop_reason ?? "end_turn"] ?? "stop",
      ...(data.usage
        ? {
            usage: {
              ...(data.usage.input_tokens !== undefined ? { promptTokens: data.usage.input_tokens } : {}),
              ...(data.usage.output_tokens !== undefined
                ? { completionTokens: data.usage.output_tokens }
                : {}),
            },
          }
        : {}),
      providerId: this.id,
      model: typeof body.model === "string" ? body.model : this.options.defaultModel,
      latencyMs,
    };
  }
}

export function createAnthropicProvider(): AnthropicCompatibleProvider | null {
  const config = getConfig();
  const provider = config.providers.anthropic;
  if (!provider.enabled) return null;
  return new AnthropicCompatibleProvider(
    "anthropic",
    {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      timeoutMs: config.agent.requestTimeoutMs,
      defaultModel: "claude-sonnet-4-20250514",
    },
    provider.version,
  );
}
