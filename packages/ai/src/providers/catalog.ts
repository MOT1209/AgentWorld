/**
 * Vendor catalog -- every model vendor the platform knows about, in one place.
 *
 * Honesty rules (read before adding a row):
 *  - A catalog entry is DATA, not a live provider. Being listed here never
 *    means "reachable". Reachability comes only from the provider registry
 *    (an API key in the environment) and is reported per entry as
 *    `configured: true/false`.
 *  - Vendors without a bundled adapter are served through the generic
 *    OpenAI-compatible adapter pointed at their base URL via the custom
 *    provider (`CUSTOM_PROVIDER_*`). Until that is configured the entry is
 *    reported unavailable -- never faked as working.
 *  - Model pricing below is ADVISORY (minor units per 1k tokens) and feeds
 *    cost estimation only. The ledger owns real money movement.
 */
import { getConfig } from "../../../shared/src/index.js";

export interface VendorEntry {
  vendorId: string;
  displayName: string;
  adapter: "openai-compatible" | "anthropic" | "google" | "custom" | "local";
  baseUrl: string;
  defaultModel: string;
  envHint: string;
  notes: string;
}

export interface VendorModelEntry {
  vendorId: string;
  modelId: string;
  displayName: string;
  capabilities: string[];
  contextWindow: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
}

export interface VendorAdapter {
  vendorId: string;
  configured: boolean;
  liveProviderId: string | null;
}

export type VendorCatalogEntry = VendorEntry &
  VendorAdapter & {
    /** Set when a bundled adapter serves this vendor right now. */
  };

export const VENDOR_CATALOG: readonly VendorEntry[] = [
  {
    vendorId: "openai",
    displayName: "OpenAI",
    adapter: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    envHint: "OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1 + OPENAI_COMPATIBLE_API_KEY",
    notes: "Served by the bundled OpenAI-compatible adapter. Configure the default endpoint or a custom provider pointed here.",
  },
  {
    vendorId: "anthropic",
    displayName: "Anthropic",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    envHint: "ANTHROPIC_ENABLED=true + ANTHROPIC_API_KEY",
    notes: "Served by the bundled Anthropic adapter (native messages API).",
  },
  {
    vendorId: "google",
    displayName: "Google AI (Gemini)",
    adapter: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.0-flash",
    envHint: "GOOGLE_ENABLED=true + GOOGLE_API_KEY",
    notes: "Served by the bundled Google adapter (native generateContent API).",
  },
  {
    vendorId: "mistral",
    displayName: "Mistral AI",
    adapter: "custom",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api.mistral.ai/v1 + CUSTOM_PROVIDER_API_KEY",
    notes: "OpenAI-compatible chat endpoint. Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "groq",
    displayName: "Groq",
    adapter: "custom",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api.groq.com/openai/v1 + CUSTOM_PROVIDER_API_KEY",
    notes: "OpenAI-compatible chat endpoint. Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "cohere",
    displayName: "Cohere",
    adapter: "custom",
    baseUrl: "https://api.cohere.com/compatibility/v1",
    defaultModel: "command-r-plus",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api.cohere.com/compatibility/v1 + CUSTOM_PROVIDER_API_KEY",
    notes: "Cohere compatibility endpoint (OpenAI shape). Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "xai",
    displayName: "xAI",
    adapter: "custom",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-2-1212",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api.x.ai/v1 + CUSTOM_PROVIDER_API_KEY",
    notes: "OpenAI-compatible chat endpoint. Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "deepseek",
    displayName: "DeepSeek",
    adapter: "custom",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api.deepseek.com/v1 + CUSTOM_PROVIDER_API_KEY",
    notes: "OpenAI-compatible chat endpoint. Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "openrouter",
    displayName: "OpenRouter",
    adapter: "custom",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "auto",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://openrouter.ai/api/v1 + CUSTOM_PROVIDER_API_KEY",
    notes: "Gateway to many vendors through one OpenAI-compatible endpoint. Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "together",
    displayName: "Together AI",
    adapter: "custom",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api.together.xyz/v1 + CUSTOM_PROVIDER_API_KEY",
    notes: "OpenAI-compatible chat endpoint. Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "fireworks",
    displayName: "Fireworks AI",
    adapter: "custom",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api.fireworks.ai/inference/v1 + CUSTOM_PROVIDER_API_KEY",
    notes: "OpenAI-compatible chat endpoint. Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "perplexity",
    displayName: "Perplexity",
    adapter: "custom",
    baseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api.perplexity.ai + CUSTOM_PROVIDER_API_KEY",
    notes: "OpenAI-compatible chat endpoint. Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "cerebras",
    displayName: "Cerebras",
    adapter: "custom",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama-3.3-70b",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api.cerebras.ai/v1 + CUSTOM_PROVIDER_API_KEY",
    notes: "OpenAI-compatible chat endpoint. Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "azure-openai",
    displayName: "Azure OpenAI",
    adapter: "custom",
    baseUrl: "https://<resource>.openai.azure.com/openai",
    defaultModel: "gpt-4o",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://<resource>.openai.azure.com/openai + CUSTOM_PROVIDER_API_KEY",
    notes: "Azure deployments vary per resource; point the custom provider at the deployment URL. Reported unavailable until then.",
  },
  {
    vendorId: "aws-bedrock",
    displayName: "AWS Bedrock",
    adapter: "custom",
    baseUrl: "https://bedrock-runtime.<region>.amazonaws.com",
    defaultModel: "anthropic.claude-sonnet-4-20250514-v1:0",
    envHint: "No bundled adapter: use the Bedrock OpenAI-compatible proxy via CUSTOM_PROVIDER_* or official SDK credentials",
    notes: "No bundled Bedrock adapter. Reachable only through an OpenAI-compatible proxy pointed at by the custom provider; otherwise unavailable.",
  },
  {
    vendorId: "google-vertex",
    displayName: "Google Vertex AI",
    adapter: "custom",
    baseUrl: "https://<region>-aiplatform.googleapis.com/v1",
    defaultModel: "gemini-2.0-flash",
    envHint: "GOOGLE_* for AI Studio, or CUSTOM_PROVIDER_* pointed at a Vertex OpenAI-compatible gateway",
    notes: "No bundled Vertex adapter. Use Google AI Studio credentials, or a Vertex gateway via the custom provider; otherwise unavailable.",
  },
  {
    vendorId: "huggingface",
    displayName: "Hugging Face Inference",
    adapter: "custom",
    baseUrl: "https://api-inference.huggingface.co/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    envHint: "CUSTOM_PROVIDER_BASE_URL=https://api-inference.huggingface.co/v1 + CUSTOM_PROVIDER_API_KEY (HF token)",
    notes: "Serverless inference router (OpenAI shape for chat models). Point the custom provider here; reported unavailable until then.",
  },
  {
    vendorId: "ollama",
    displayName: "Ollama (local)",
    adapter: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "llama3.1",
    envHint: "LOCAL_AI_ENABLED=true + LOCAL_AI_BASE_URL=http://127.0.0.1:11434/v1",
    notes: "Self-hosted runtime. Served by the local provider entry; no cloud credentials involved.",
  },
  {
    vendorId: "vllm",
    displayName: "vLLM (local)",
    adapter: "local",
    baseUrl: "http://127.0.0.1:8000/v1",
    defaultModel: "llama3.1",
    envHint: "LOCAL_AI_ENABLED=true + LOCAL_AI_BASE_URL=http://127.0.0.1:8000/v1",
    notes: "Self-hosted runtime. Served by the local provider entry; no cloud credentials involved.",
  },
  {
    vendorId: "llamacpp",
    displayName: "llama.cpp server (local)",
    adapter: "local",
    baseUrl: "http://127.0.0.1:8080/v1",
    defaultModel: "llama3.1",
    envHint: "LOCAL_AI_ENABLED=true + LOCAL_AI_BASE_URL=http://127.0.0.1:8080/v1",
    notes: "Self-hosted runtime. Served by the local provider entry; no cloud credentials involved.",
  },
];

/**
 * Advisory model entries, one family per vendor. `available` is refreshed from
 * the provider registry at query time, so every vendor below reports
 * unavailable until its adapter is genuinely configured.
 */
export const VENDOR_MODELS: readonly VendorModelEntry[] = [
  { vendorId: "openai", modelId: "gpt-4o", displayName: "GPT-4o (via OpenAI)", capabilities: ["chat", "tools", "vision", "structured", "audio"], contextWindow: 128_000, inputCostPer1k: 2, outputCostPer1k: 8 },
  { vendorId: "openai", modelId: "gpt-4o-mini", displayName: "GPT-4o mini (via OpenAI)", capabilities: ["chat", "tools", "vision", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "openai", modelId: "o3-mini", displayName: "o3-mini (via OpenAI)", capabilities: ["chat", "tools", "structured", "reasoning"], contextWindow: 128_000, inputCostPer1k: 1, outputCostPer1k: 4 },
  { vendorId: "mistral", modelId: "mistral-large-latest", displayName: "Mistral Large", capabilities: ["chat", "tools", "structured", "reasoning"], contextWindow: 128_000, inputCostPer1k: 2, outputCostPer1k: 6 },
  { vendorId: "mistral", modelId: "mistral-small-latest", displayName: "Mistral Small", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "groq", modelId: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B (via Groq)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "cohere", modelId: "command-r-plus", displayName: "Command R+ (via Cohere)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 2, outputCostPer1k: 6 },
  { vendorId: "xai", modelId: "grok-2-1212", displayName: "Grok 2 (via xAI)", capabilities: ["chat", "tools", "vision", "structured"], contextWindow: 131_072, inputCostPer1k: 2, outputCostPer1k: 10 },
  { vendorId: "deepseek", modelId: "deepseek-chat", displayName: "DeepSeek V3", capabilities: ["chat", "tools", "structured"], contextWindow: 64_000, inputCostPer1k: 0, outputCostPer1k: 1 },
  { vendorId: "deepseek", modelId: "deepseek-reasoner", displayName: "DeepSeek R1", capabilities: ["chat", "tools", "structured", "reasoning"], contextWindow: 64_000, inputCostPer1k: 0, outputCostPer1k: 2 },
  { vendorId: "openrouter", modelId: "auto", displayName: "OpenRouter Auto", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 1, outputCostPer1k: 3 },
  { vendorId: "together", modelId: "meta-llama/Llama-3.3-70B-Instruct-Turbo", displayName: "Llama 3.3 70B (via Together)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "fireworks", modelId: "accounts/fireworks/models/llama-v3p3-70b-instruct", displayName: "Llama 3.3 70B (via Fireworks)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "perplexity", modelId: "sonar", displayName: "Sonar (via Perplexity)", capabilities: ["chat", "structured"], contextWindow: 128_000, inputCostPer1k: 1, outputCostPer1k: 1 },
  { vendorId: "cerebras", modelId: "llama-3.3-70b", displayName: "Llama 3.3 70B (via Cerebras)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "azure-openai", modelId: "gpt-4o", displayName: "GPT-4o (via Azure)", capabilities: ["chat", "tools", "vision", "structured", "audio"], contextWindow: 128_000, inputCostPer1k: 2, outputCostPer1k: 8 },
  { vendorId: "aws-bedrock", modelId: "anthropic.claude-sonnet-4-20250514-v1:0", displayName: "Claude Sonnet 4 (via Bedrock)", capabilities: ["chat", "tools", "vision", "structured", "reasoning"], contextWindow: 200_000, inputCostPer1k: 3, outputCostPer1k: 15 },
  { vendorId: "google-vertex", modelId: "gemini-2.0-flash", displayName: "Gemini Flash (via Vertex)", capabilities: ["chat", "tools", "vision", "audio", "structured"], contextWindow: 1_000_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "huggingface", modelId: "meta-llama/Llama-3.3-70B-Instruct", displayName: "Llama 3.3 70B (via Hugging Face)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 1 },
  { vendorId: "ollama", modelId: "llama3.1", displayName: "Llama 3.1 (via Ollama)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "ollama", modelId: "qwen2.5-coder", displayName: "Qwen 2.5 Coder (via Ollama)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "vllm", modelId: "llama3.1", displayName: "Llama 3.1 (via vLLM)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
  { vendorId: "llamacpp", modelId: "llama3.1", displayName: "Llama 3.1 (via llama.cpp)", capabilities: ["chat", "tools", "structured"], contextWindow: 128_000, inputCostPer1k: 0, outputCostPer1k: 0 },
];

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Merges the static catalog with live configuration. `configured` is true
 * only when a bundled adapter genuinely serves the vendor right now; every
 * other entry reports the exact env change that would enable it.
 */
export function describeVendorCatalog(): VendorCatalogEntry[] {
  const config = getConfig();
  const customOrigin = config.aiGateway.customProvider.enabled
    ? originOf(config.aiGateway.customProvider.baseUrl)
    : null;
  const customMatches = (vendorBase: string): boolean => {
    if (customOrigin === null) return false;
    const vendorOrigin = originOf(vendorBase);
    return vendorOrigin !== null && vendorOrigin === customOrigin;
  };
  const localMatches = (vendorBase: string): boolean => {
    if (!config.aiGateway.localAi.enabled) return false;
    const localOrigin = originOf(config.aiGateway.localAi.baseUrl);
    const vendorOrigin = originOf(vendorBase);
    if (localOrigin !== null && vendorOrigin !== null && localOrigin === vendorOrigin) return true;
    // The local entry serves any localhost runtime once enabled, even when
    // the configured URL differs from the vendor default.
    return localOrigin !== null && (localOrigin.includes("127.0.0.1") || localOrigin.includes("localhost"));
  };
  return VENDOR_CATALOG.map((vendor) => {
    switch (vendor.vendorId) {
      case "openai":
        return {
          ...vendor,
          configured:
            config.providers.openaiCompatible.enabled &&
            originOf(config.providers.openaiCompatible.baseUrl) === originOf("https://api.openai.com/v1"),
          liveProviderId: "openai-compatible",
        };
      case "anthropic":
        return { ...vendor, configured: config.providers.anthropic.enabled, liveProviderId: "anthropic" };
      case "google":
        return { ...vendor, configured: config.providers.google.enabled, liveProviderId: "google" };
      case "ollama":
      case "vllm":
      case "llamacpp": {
        const live = localMatches(vendor.baseUrl);
        return { ...vendor, configured: live, liveProviderId: live ? "local" : null };
      }
      default: {
        const live = customMatches(vendor.baseUrl);
        return {
          ...vendor,
          configured: live,
          liveProviderId: live && config.aiGateway.customProvider.id !== "" ? config.aiGateway.customProvider.id : null,
        };
      }
    }
  });
}
