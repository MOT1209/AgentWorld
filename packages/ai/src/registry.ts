/**
 * Provider registry.
 *
 * The only place that knows which providers exist. Agents reference a provider
 * by id string, so switching Ahmad to a different vendor is a database update,
 * never a code change.
 *
 * `mock` is always registered and always available: the system must be runnable
 * end to end on a fresh clone with no credentials, or "it doesn't work without
 * an API key" becomes the first thing anyone experiences.
 */
import { getConfig, notFound, serviceUnavailable } from "../../shared/src/index.js";
import type { AIProvider, ProviderDescriptor } from "./types.js";
import { MockProvider } from "./providers/mock.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.js";
import { AnthropicCompatibleProvider } from "./providers/anthropic.js";
import { GoogleCompatibleProvider } from "./providers/google.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();

  constructor(providers: AIProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: AIProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  registerAll(providers: AIProvider[]): this {
    for (const provider of providers) this.register(provider);
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): AIProvider {
    const provider = this.providers.get(id);
    if (provider === undefined) {
      const known = [...this.providers.keys()].join(", ") || "none";
      throw notFound(`AI provider '${id}'`, `available: ${known}`);
    }
    return provider;
  }

  /** Resolves and verifies readiness in one step. */
  require(id: string): AIProvider {
    const provider = this.get(id);
    if (!provider.isAvailable()) {
      throw serviceUnavailable(
        `AI provider '${id}' is registered but not configured. Set its API key in the environment.`,
      );
    }
    return provider;
  }

  list(): ProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => provider.describe());
  }

  defaultProviderId(): string {
    const configured = getConfig().providers.defaultProviderId;
    if (this.providers.has(configured)) return configured;
    // Falling back keeps a stale DEFAULT_PROVIDER from bricking the system.
    return this.providers.has("mock") ? "mock" : [...this.providers.keys()][0] ?? "mock";
  }

  get size(): number {
    return this.providers.size;
  }
}

function configuredProviders(): AIProvider[] {
  const config = getConfig();
  const providers: AIProvider[] = [new MockProvider()];

  const openai = config.providers.openaiCompatible;
  if (openai.enabled) {
    providers.push(
      new OpenAiCompatibleProvider("openai-compatible", {
        apiKey: openai.apiKey,
        baseUrl: openai.baseUrl,
        timeoutMs: config.agent.requestTimeoutMs,
        defaultModel: "gpt-4o-mini",
      }),
    );
  }

  const anthropic = config.providers.anthropic;
  if (anthropic.enabled) {
    providers.push(
      new AnthropicCompatibleProvider(
        "anthropic",
        {
          apiKey: anthropic.apiKey,
          baseUrl: anthropic.baseUrl,
          timeoutMs: config.agent.requestTimeoutMs,
          defaultModel: "claude-sonnet-4-20250514",
        },
        anthropic.version,
      ),
    );
  }

  const google = config.providers.google;
  if (google.enabled) {
    providers.push(
      new GoogleCompatibleProvider("google", {
        apiKey: google.apiKey,
        baseUrl: google.baseUrl,
        timeoutMs: config.agent.requestTimeoutMs,
        defaultModel: "gemini-2.0-flash",
      }),
    );
  }

  return providers;
}

let registry: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (registry === null) {
    registry = new ProviderRegistry(configuredProviders());
  }
  return registry;
}

/** Test hook: installs an isolated registry. */
export function setProviderRegistry(next: ProviderRegistry | null): void {
  registry = next;
}

/**
 * Convenience for the seed: registers any additional mock providers declared in
 * tests so an agent can be pinned to an arbitrary provider id.
 */
export function ensureMockProvider(id: string): void {
  const current = getProviderRegistry();
  if (!current.has(id)) {
    current.register(new MockProvider(id));
  }
}
