/**
 * Model registry -- capabilities, context windows and pricing per model.
 *
 * Models are DATA. Capabilities are declared, never guessed from names; the
 * registry validates that a request's required capabilities exist so a typo
 * fails loudly instead of silently routing to a model that cannot do the work.
 * Pricing is advisory (minor units per 1k tokens) and feeds cost estimation
 * only -- the ledger owns any actual money movement.
 */
import { validationError } from "../../shared/src/index.js";
import { VENDOR_MODELS } from "./providers/catalog.js";

export const MODEL_CAPABILITIES = [
  "chat",
  "tools",
  "vision",
  "audio",
  "image",
  "video",
  "structured",
  "reasoning",
  "embeddings",
  "fine-tuning",
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export function isModelCapability(value: string): value is ModelCapability {
  return (MODEL_CAPABILITIES as readonly string[]).includes(value);
}

export interface ModelEntry {
  providerId: string;
  modelId: string;
  displayName: string;
  capabilities: ModelCapability[];
  contextWindow: number;
  /** Minor units per 1k input/output tokens. Advisory. */
  inputCostPer1k: number;
  outputCostPer1k: number;
  /** Callable right now (registered + configured provider). */
  available: boolean;
}

export interface ModelQuery {
  providerId?: string;
  capabilities?: string[];
  /** Max acceptable input+output estimate per call, minor units. */
  maxCostPer1k?: number;
  minContextWindow?: number;
}

function entry(
  providerId: string,
  modelId: string,
  displayName: string,
  capabilities: ModelCapability[],
  contextWindow: number,
  inputCostPer1k: number,
  outputCostPer1k: number,
  available = false,
): ModelEntry {
  return {
    providerId,
    modelId,
    displayName,
    capabilities,
    contextWindow,
    inputCostPer1k,
    outputCostPer1k,
    available,
  };
}

/**
 * Built-in catalogue. `available` is refreshed from the provider registry at
 * query time (see refreshAvailability), so entries stay declarative while
 * availability reflects the running configuration. The mock provider always
 * exists so the catalogue is never empty.
 */
export const BUILT_IN_MODELS: ModelEntry[] = [
  entry("mock", "mock-1", "Deterministic Mock", ["chat", "tools", "structured"], 8_192, 0, 0, true),

  entry("openai-compatible", "gpt-4o", "GPT-4o", ["chat", "tools", "vision", "structured", "audio"], 128_000, 2, 8),
  entry("openai-compatible", "gpt-4o-mini", "GPT-4o mini", ["chat", "tools", "vision", "structured"], 128_000, 0, 0),
  entry("openai-compatible", "o3-mini", "o3-mini", ["chat", "tools", "structured", "reasoning"], 128_000, 1, 4),

  entry("anthropic", "claude-sonnet-4-20250514", "Claude Sonnet 4", ["chat", "tools", "vision", "structured", "reasoning"], 200_000, 3, 15),
  entry("anthropic", "claude-haiku-4-20250514", "Claude Haiku 4", ["chat", "tools", "vision", "structured"], 200_000, 0, 4),

  entry("google", "gemini-2.0-flash", "Gemini 2.0 Flash", ["chat", "tools", "vision", "audio", "structured"], 1_000_000, 0, 0),
  entry("google", "gemini-2.0-pro", "Gemini 2.0 Pro", ["chat", "tools", "vision", "structured", "reasoning"], 2_000_000, 1, 6),

  entry("local", "llama3.1", "Llama 3.1 (local)", ["chat", "tools", "structured"], 128_000, 0, 0),
  entry("local", "qwen2.5-coder", "Qwen 2.5 Coder (local)", ["chat", "tools", "structured"], 128_000, 0, 0),
];

/** Vendor catalog entries as registry rows. `available` starts false and is
 *  refreshed from the live provider registry at query time, so every vendor
 *  reports unavailable until its adapter is genuinely configured. */
function vendorModelEntries(): ModelEntry[] {
  return VENDOR_MODELS.map((model) =>
    entry(
      model.vendorId,
      model.modelId,
      model.displayName,
      [...model.capabilities] as ModelCapability[],
      model.contextWindow,
      model.inputCostPer1k,
      model.outputCostPer1k,
      false,
    ),
  );
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelEntry>();

  constructor(entries: ModelEntry[] = [...BUILT_IN_MODELS, ...vendorModelEntries()]) {
    for (const model of entries) this.register(model);
  }

  register(model: ModelEntry): this {
    const key = `${model.providerId}::${model.modelId}`;
    this.models.set(key, model);
    return this;
  }

  has(providerId: string, modelId: string): boolean {
    return this.models.has(`${providerId}::${modelId}`);
  }

  get(providerId: string, modelId: string): ModelEntry {
    const model = this.models.get(`${providerId}::${modelId}`);
    if (model === undefined) throw validationError(`Unknown model '${modelId}' on provider '${providerId}'`);
    return model;
  }

  /** Availability refresh from a live provider registry (descriptor-driven). */
  refreshAvailability(availableProviderIds: ReadonlySet<string>): void {
    for (const model of this.models.values()) {
      model.available = model.providerId === "mock"
        ? true
        : availableProviderIds.has(model.providerId);
    }
  }

  list(query: ModelQuery = {}): ModelEntry[] {
    return [...this.models.values()].filter((model) => {
      if (query.providerId !== undefined && model.providerId !== query.providerId) return false;
      if (query.capabilities !== undefined) {
        for (const capability of query.capabilities) {
          if (!model.capabilities.includes(capability as ModelCapability)) return false;
        }
      }
      if (query.maxCostPer1k !== undefined && Math.max(model.inputCostPer1k, model.outputCostPer1k) > query.maxCostPer1k) return false;
      if (query.minContextWindow !== undefined && model.contextWindow < query.minContextWindow) return false;
      return true;
    });
  }

  /** Ranked cheapest-first among entries satisfying the query. */
  pick(query: ModelQuery = {}): ModelEntry | null {
    const matches = this.list(query).sort(
      (a, b) => a.inputCostPer1k + a.outputCostPer1k - (b.inputCostPer1k + b.outputCostPer1k),
    );
    return matches.find((model) => model.available) ?? null;
  }
}

export const modelRegistry = new ModelRegistry();

/** Estimated cost in minor units for one call. Zero for the mock. */
export function estimateCostMinor(
  model: Pick<ModelEntry, "inputCostPer1k" | "outputCostPer1k">,
  inputTokens: number,
  outputTokens: number,
): number {
  return Math.ceil(
    (inputTokens / 1_000) * model.inputCostPer1k + (outputTokens / 1_000) * model.outputCostPer1k,
  );
}
