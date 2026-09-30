/**
 * Google (Gemini) compatible provider.
 *
 * Uses the generativelanguage `generateContent` shape. Two structural
 * differences from OpenAI are handled here: the model id lives in the URL
 * rather than the body, and a `systemInstruction` field carries the system
 * prompt.
 */
import { aiProviderError, getConfig } from "../../../shared/src/index.js";
import { postJson } from "../http.js";
import {
  parseToolArguments,
  type AIProvider,
  type CompletionRequest,
  type CompletionResult,
  type ProviderDescriptor,
  type ProviderKind,
  type ProviderOptions,
} from "../types.js";

interface GoogleResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; status?: string };
}

const FINISH_REASON_MAP: Record<string, CompletionResult["finishReason"]> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
};

export class GoogleCompatibleProvider implements AIProvider {
  readonly id: string;
  readonly kind: ProviderKind = "GOOGLE";
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
      displayName: "Google Gemini",
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
    const model = request.model || this.options.defaultModel;
    const base = this.options.baseUrl.replace(/\/$/, "");

    const systemParts: string[] = [];
    const contents: Array<{ role: string; parts: unknown[] }> = [];

    for (const message of request.messages) {
      if (message.role === "system") {
        systemParts.push(message.content);
        continue;
      }
      if (message.role === "tool") {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: message.name ?? "tool",
                response: { content: message.content },
              },
            },
          ],
        });
        continue;
      }
      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        const parts: unknown[] = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls) {
          parts.push({ functionCall: { name: call.name, args: call.arguments } });
        }
        contents.push({ role: "model", parts });
        continue;
      }
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      });
    }

    const body: Record<string, unknown> = { contents };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
    }
    body.generationConfig = {
      temperature: request.temperature ?? 0.3,
      maxOutputTokens: request.maxTokens ?? 2048,
      ...(request.stop && request.stop.length > 0 ? { stopSequences: request.stop } : {}),
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ];
    }

    const { data, latencyMs } = await postJson<GoogleResponse>({
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      headers: {
        "x-goog-api-key": this.options.apiKey,
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

    const candidate = data.candidates?.[0];
    if (candidate === undefined) {
      throw aiProviderError(`Provider '${this.id}' returned no candidates`);
    }

    const parts = candidate.content?.parts ?? [];
    const content = parts
      .filter((part) => part.text !== undefined)
      .map((part) => part.text ?? "")
      .join("");
    const toolCalls = parts
      .filter((part) => part.functionCall !== undefined)
      .map((part, index) => ({
        id: `call_${index}_${part.functionCall?.name ?? "tool"}`,
        name: part.functionCall?.name ?? "unknown",
        arguments: parseToolArguments(part.functionCall?.args ?? {}, part.functionCall?.name ?? "unknown"),
      }));

    const finishReasonRaw = candidate.finishReason ?? "STOP";
    const hasToolCalls = toolCalls.length > 0;

    return {
      content,
      toolCalls,
      finishReason: hasToolCalls
        ? "tool_calls"
        : (FINISH_REASON_MAP[finishReasonRaw] ?? "stop"),
      ...(data.usageMetadata
        ? {
            usage: {
              ...(data.usageMetadata.promptTokenCount !== undefined
                ? { promptTokens: data.usageMetadata.promptTokenCount }
                : {}),
              ...(data.usageMetadata.candidatesTokenCount !== undefined
                ? { completionTokens: data.usageMetadata.candidatesTokenCount }
                : {}),
              ...(data.usageMetadata.totalTokenCount !== undefined
                ? { totalTokens: data.usageMetadata.totalTokenCount }
                : {}),
            },
          }
        : {}),
      providerId: this.id,
      model,
      latencyMs,
    };
  }
}

export function createGoogleProvider(): GoogleCompatibleProvider | null {
  const config = getConfig();
  const provider = config.providers.google;
  if (!provider.enabled) return null;
  return new GoogleCompatibleProvider("google", {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    timeoutMs: config.agent.requestTimeoutMs,
    defaultModel: "gemini-2.0-flash",
  });
}
