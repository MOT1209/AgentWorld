/**
 * OpenAI-compatible provider.
 *
 * Covers OpenAI itself and anything that speaks the `/v1/chat/completions`
 * shape: Groq, OpenRouter, Together, Fireworks, DeepSeek, LM Studio, vLLM,
 * llama.cpp's server and Ollama's compatibility shim.
 *
 * This is the single most useful adapter in the system: it is why adding a new
 * model vendor is a `.env` change rather than a code change.
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

interface OpenAiToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string };
}

function toApiMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

const FINISH_REASON_MAP: Record<string, CompletionResult["finishReason"]> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  content_filter: "content_filter",
};

export class OpenAiCompatibleProvider implements AIProvider {
  readonly id: string;
  readonly kind: ProviderKind = "OPENAI_COMPATIBLE";
  private readonly options: ProviderOptions;

  constructor(id: string, options: ProviderOptions) {
    this.id = id;
    this.options = options;
  }

  isAvailable(): boolean {
    return this.options.apiKey !== "";
  }

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: "OpenAI-compatible",
      configured: this.isAvailable(),
      defaultModel: this.options.defaultModel,
      models: [],
      notes: `Any /v1/chat/completions endpoint. Base URL: ${this.options.baseUrl}`,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.isAvailable()) {
      throw aiProviderError(
        `Provider '${this.id}' is not configured. Set the matching API key in the environment.`,
      );
    }
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const body: Record<string, unknown> = {
      model: request.model || this.options.defaultModel,
      messages: toApiMessages(request.messages),
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 2048,
      ...(request.stop && request.stop.length > 0 ? { stop: request.stop } : {}),
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = "auto";
    }

    const { data, latencyMs } = await postJson<OpenAiResponse>({
      url,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
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

    const choice = data.choices?.[0];
    if (choice === undefined) {
      throw aiProviderError(`Provider '${this.id}' returned no choices`);
    }

    const toolCalls = (choice.message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: parseToolArguments(call.function.arguments, call.function.name),
    }));

    return {
      content: choice.message?.content ?? "",
      toolCalls,
      finishReason: FINISH_REASON_MAP[choice.finish_reason ?? "stop"] ?? "stop",
      ...(data.usage
        ? {
            usage: {
              ...(data.usage.prompt_tokens !== undefined ? { promptTokens: data.usage.prompt_tokens } : {}),
              ...(data.usage.completion_tokens !== undefined
                ? { completionTokens: data.usage.completion_tokens }
                : {}),
              ...(data.usage.total_tokens !== undefined ? { totalTokens: data.usage.total_tokens } : {}),
            },
          }
        : {}),
      providerId: this.id,
      model: typeof body.model === "string" ? body.model : this.options.defaultModel,
      latencyMs,
    };
  }
}

export function createOpenAiCompatibleProvider(): OpenAiCompatibleProvider | null {
  const config = getConfig();
  const provider = config.providers.openaiCompatible;
  if (!provider.enabled) return null;
  return new OpenAiCompatibleProvider("openai-compatible", {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    timeoutMs: config.agent.requestTimeoutMs,
    defaultModel: "gpt-4o-mini",
  });
}
