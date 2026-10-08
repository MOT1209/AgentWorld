/**
 * Model router.
 *
 * Picks which provider/model actually serves a run. The agent runtime records
 * the routed pair on the AgentSession, so routing stays auditable after the
 * fact. Rules, in order:
 *
 *  1. EXPLICIT WINS AND IS VALIDATED. A requested providerId must exist and
 *     be available; a requested model must be served by its provider. Typos
 *     fail loudly instead of silently landing on another vendor.
 *  2. CAPABILITY RANKING. Reasoning work prefers ANTHROPIC then
 *     OPENAI_COMPATIBLE; code work prefers OPENAI_COMPATIBLE then ANTHROPIC;
 *     everything else takes the configured default.
 *  3. FALLBACK IS HONEST. When the ranked class is unavailable the router
 *     falls back to the default provider and says so (`fallback: true`) so
 *     the caller can decide whether degraded mode is acceptable.
 *
 * The router never calls a vendor: it returns an address, and the runtime
 * dials it through the normal `AIProvider.complete` path.
 */
import { notFound, serviceUnavailable } from "../../shared/src/index.js";
import { modelRegistry } from "./model-registry.js";
import { getProviderRegistry, type ProviderRegistry } from "./registry.js";
import type { ProviderKind } from "./types.js";

export type LatencyProfile = "fast" | "normal";

export interface ModelRequest {
  providerId?: string;
  model?: string;
  /** Declarative capability, e.g. "software" | "planning" | "testing". */
  capability?: string;
  /** TaskType string, e.g. "IMPLEMENTATION" | "RESEARCH". */
  taskType?: string;
  latency?: LatencyProfile;
  reasoning?: boolean;
  /** Maximum acceptable input+output estimate per call, minor units per 1k tokens. */
  maxCostPer1k?: number;
  /** Minimum context window the serving model must offer. */
  minContextWindow?: number;
  /** Estimated prompt size; providers whose default model cannot fit it are skipped. */
  estimatedTokens?: number;
}

export interface ModelRoute {
  providerId: string;
  model: string;
  /** Why this address was picked. Recorded on the session. */
  reason: string;
  /** True when the ranked class was unavailable and the default filled in. */
  fallback: boolean;
}

const REASONING_KINDS: readonly ProviderKind[] = ["ANTHROPIC", "OPENAI_COMPATIBLE", "GOOGLE"];
const CODING_KINDS: readonly ProviderKind[] = ["OPENAI_COMPATIBLE", "ANTHROPIC", "GOOGLE"];

const CODING_TASK_TYPES = ["IMPLEMENTATION", "TESTING", "REVIEW"] as const;
const CODING_CAPABILITIES = ["software", "testing", "quality"] as const;
const REASONING_TASK_TYPES = ["PLANNING", "ANALYSIS", "RESEARCH"] as const;
const REASONING_CAPABILITIES = ["planning", "analysis", "research"] as const;

function wantsReasoning(request: ModelRequest): boolean {
  if (request.reasoning === true) return true;
  if (request.taskType !== undefined &&
    (REASONING_TASK_TYPES as readonly string[]).includes(request.taskType.toUpperCase())) return true;
  if (request.capability !== undefined &&
    (REASONING_CAPABILITIES as readonly string[]).includes(request.capability.toLowerCase())) return true;
  return false;
}

function wantsCoding(request: ModelRequest): boolean {
  if (request.taskType !== undefined &&
    (CODING_TASK_TYPES as readonly string[]).includes(request.taskType.toUpperCase())) return true;
  if (request.capability !== undefined &&
    (CODING_CAPABILITIES as readonly string[]).includes(request.capability.toLowerCase())) return true;
  return false;
}

/** True when the request carries budget or context constraints. */
function hasRoutingConstraints(request: ModelRequest): boolean {
  return request.maxCostPer1k !== undefined ||
    request.minContextWindow !== undefined ||
    request.estimatedTokens !== undefined;
}

/**
 * Cheapest model on a provider satisfying the request's budget and context
 * constraints. Null when nothing qualifies, so the caller skips the
 * provider instead of routing to a model that cannot do the work.
 */
function bestModelFor(providerId: string, request: ModelRequest): string | null {
  const needsContext = request.minContextWindow ?? request.estimatedTokens;
  const matches = modelRegistry.list({
    providerId,
    ...(request.maxCostPer1k !== undefined ? { maxCostPer1k: request.maxCostPer1k } : {}),
    ...(needsContext !== undefined ? { minContextWindow: needsContext } : {}),
  });
  if (matches.length === 0) return null;
  const cheapest = matches.sort(
    (a, b) => a.inputCostPer1k + a.outputCostPer1k - (b.inputCostPer1k + b.outputCostPer1k),
  )[0];
  return cheapest?.modelId ?? null;
}

export function routeModel(request: ModelRequest, registry: ProviderRegistry = getProviderRegistry()): ModelRoute {
  // 1. Explicit provider: validate, never silently substitute.
  if (request.providerId !== undefined) {
    const provider = registry.require(request.providerId);
    const descriptor = provider.describe();
    const model = request.model ?? descriptor.defaultModel;
    if (request.model !== undefined && !descriptor.models.includes(request.model) && descriptor.models.length > 0) {
      throw notFound(`Model '${request.model}' on provider '${request.providerId}'`);
    }
    return { providerId: provider.id, model, reason: "explicit", fallback: false };
  }

  const available = registry.list().filter((descriptor) => descriptor.configured);

  // 2b. Explicit model without a provider: find who serves it.
  if (request.model !== undefined) {
    const serving = available.find((descriptor) => descriptor.models.includes(request.model as string));
    if (serving === undefined) {
      throw notFound(`Model '${request.model}' on any configured provider`);
    }
    return { providerId: serving.id, model: request.model, reason: "model-match", fallback: false };
  }

  // 2. Ranked classes, honouring budget and context constraints. A provider
  //    whose models cannot satisfy the constraints is skipped, never forced.
  const ranking = wantsReasoning(request) ? REASONING_KINDS : wantsCoding(request) ? CODING_KINDS : null;
  if (ranking !== null) {
    for (const kind of ranking) {
      const match = available.find((descriptor) => descriptor.kind === kind);
      if (match !== undefined) {
        const model = hasRoutingConstraints(request) ? bestModelFor(match.id, request) : match.defaultModel;
        if (model !== null) {
          return {
            providerId: match.id,
            model,
            reason: wantsReasoning(request) ? "reasoning-rank" : "coding-rank",
            fallback: false,
          };
        }
      }
    }
  }

  // 3. Honest fallback to the configured default (mock when nothing else is).
  const fallbackId = registry.defaultProviderId();
  const fallback = registry.get(fallbackId).describe();
  if (!fallback.configured) {
    throw serviceUnavailable("No AI provider is available for this request");
  }
  return {
    providerId: fallback.id,
    model: fallback.defaultModel,
    reason: ranking === null ? "default" : "fallback-default",
    fallback: ranking !== null,
  };
}
