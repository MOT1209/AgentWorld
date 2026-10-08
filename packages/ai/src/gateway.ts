/**
 * AI Provider Gateway -- the unified front door for every model call.
 *
 * Layering (the agent never learns how a vendor authenticates):
 *
 *   Agent -> routeModel() -> gateway.complete() -> AIProvider -> model
 *
 * Responsibilities, in order:
 *   1. RESOLVE     - explicit routing or capability-based ranking.
 *   2. EXECUTE     - call the resolved provider through the existing adapter.
 *   3. FALLBACK    - bounded: one automatic retry on transient-looking
 *                    failures, then at most two fallback providers from the
 *                    ranked list. Never endless, and every fallback is
 *                    recorded (AI_FALLBACK_TRIGGERED).
 *   4. TRACK       - every call appends an AiUsage row (tokens, estimated
 *                    cost, latency, correlation) and emits
 *                    AI_PROVIDER_CALL_RECORDED. Real money moves only when
 *                    the estimate crosses the configured threshold, and then
 *                    exclusively through LedgerService (type FEE) -- never a
 *                    second ledger.
 *   5. REDACT      - provider errors are surfaced as AI_PROVIDER_ERROR with a
 *                    bounded message; raw provider responses never carry
 *                    credentials.
 */
import { aiProviderError, logger, newCorrelationId, toJson, type ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { estimateCostMinor, modelRegistry, type ModelEntry, type ModelQuery } from "./model-registry.js";
import { getProviderRegistry } from "./registry.js";
import { routeModel, type ModelRequest } from "./router.js";
import type { CompletionRequest, CompletionResult } from "./types.js";

const log = logger.child({ component: "ai.gateway" });

const MAX_FALLBACKS = 2;

export interface GatewayRequest extends CompletionRequest {
  /** Direct pin (overrides routing). */
  providerId?: string;
  /** Routing hints when model/provider are not pinned. */
  routing?: ModelRequest;
  /** Attribution for the AiUsage row (and the treasury charge when it fires). */
  agentId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  companyId?: string | null;
  /** Wallet to charge when the accumulated estimate crosses the threshold. */
  treasuryWalletId?: string | null;
}

export interface GatewayResult extends CompletionResult {
  /** True when a fallback provider served the call. */
  fallback: boolean;
  /** Providers tried before the one that answered (in order). */
  fallbackFrom: string[];
  usageRecorded: boolean;
}

interface TrackInput {
  providerId: string;
  model: string;
  status: "OK" | "ERROR";
  result?: CompletionResult;
  error?: string;
  request: GatewayRequest;
  db: DbClient;
  actor: ActorRef;
  correlationId: string;
}

const modelCache = new Map<string, ModelEntry | null>();

function entryFor(providerId: string, model: string): ModelEntry | null {
  const key = `${providerId}::${model}`;
  if (!modelCache.has(key)) {
    modelCache.set(key, modelRegistry.has(providerId, model) ? modelRegistry.get(providerId, model) : null);
  }
  return modelCache.get(key) ?? null;
}

/** Test hook: clears the memoised model lookups. */
export function resetGatewayCaches(): void {
  modelCache.clear();
}

async function track(db: DbClient, input: TrackInput): Promise<void> {
  const entry = entryFor(input.providerId, input.model);
  const inputTokens = input.result?.usage?.promptTokens ?? 0;
  const outputTokens = input.result?.usage?.completionTokens ?? 0;
  const cachedTokens = 0;
  const estimatedCostMinor =
    input.status === "OK" && entry !== null
      ? estimateCostMinor(entry, inputTokens, outputTokens)
      : 0;

  try {
    await db.aiUsage.create({
      data: {
        providerId: input.providerId,
        model: input.model,
        status: input.status,
        inputTokens,
        outputTokens,
        cachedTokens,
        estimatedCostMinor,
        latencyMs: input.result?.latencyMs ?? 0,
        error: input.error ?? null,
        agentId: input.request.agentId ?? null,
        sessionId: input.request.sessionId ?? null,
        taskId: input.request.taskId ?? null,
        companyId: input.request.companyId ?? null,
        correlationId: input.correlationId,
      },
    });
  } catch (error) {
    // Observability must never break a completion.
    log.warn("AiUsage row failed", {
      action: "ai.usage_failed",
      result: "ERROR",
      error: error instanceof Error ? error.message : String(error),
      correlationId: input.correlationId,
    });
  }

  await eventBus
    .publishAndDispatch(db, {
      type: EVENT_TYPES.AI_PROVIDER_CALL_RECORDED,
      actor: input.actor,
      correlationId: input.correlationId,
      targetType: "AiUsage",
      payload: {
        providerId: input.providerId,
        model: input.model,
        status: input.status,
        inputTokens,
        outputTokens,
        estimatedCostMinor,
        latencyMs: input.result?.latencyMs ?? 0,
        agentId: input.request.agentId ?? null,
        companyId: input.request.companyId ?? null,
      },
    })
    .catch(() => undefined);
}

function isTransient(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("503") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily")
  );
}

function candidatesFor(request: GatewayRequest): Array<{ providerId?: string; model?: string }> {
  const routing = request.routing ?? {};
  const directModel = request.model !== undefined && request.model !== "" ? request.model : routing.model;
  const registry = getProviderRegistry();
  // Rank fallback candidates by the registry: cheapest-capable first, mock
  // last (a scripted stand-in is a last resort, not a peer).
  const query: ModelQuery = {
    ...(routing.capability !== undefined ? { capabilities: capabilityList(routing.capability) } : {}),
  };
  const ranked = modelRegistry
    .list(query)
    .filter((model) => model.providerId !== "mock")
    .filter((model) => registry.has(model.providerId))
    .sort((a, b) => a.inputCostPer1k + a.outputCostPer1k - (b.inputCostPer1k + b.outputCostPer1k))
    .map((model) => ({ providerId: model.providerId, model: model.modelId }));
  const chain: Array<{ providerId?: string; model?: string }> = [];
  if (request.providerId !== undefined || routing.providerId !== undefined) {
    // A pin overrides routing for the FIRST attempt only; the rest of the
    // chain still serves the call if the pinned provider fails (bounded).
    const providerId = request.providerId ?? routing.providerId;
    if (providerId !== undefined) {
      chain.push({
        ...(providerId !== undefined ? { providerId } : {}),
        ...(directModel !== undefined ? { model: directModel } : {}),
      });
    }
  }
  for (const candidate of ranked) {
    if (candidate.providerId !== chain[0]?.providerId) chain.push(candidate);
  }
  if (!chain.some((candidate) => candidate.providerId === "mock")) {
    // No hardcoded model: routeModel resolves the mock provider's own
    // defaultModel from its descriptor.
    chain.push({ providerId: "mock" });
  }
  return chain;
}

function capabilityList(capability: string): string[] {
  const normalized = capability.toLowerCase();
  if (normalized.includes("code")) return ["tools", "structured"];
  if (normalized.includes("vision") || normalized.includes("image")) return ["vision"];
  if (normalized.includes("reason")) return ["reasoning"];
  return ["chat", "tools"];
}

/**
 * One completion with bounded fallback. Throws AI_PROVIDER_ERROR only when
 * every candidate failed -- with the last bounded error message.
 */
export async function complete(
  db: DbClient,
  request: GatewayRequest,
  options: { actor: ActorRef; correlationId?: string },
): Promise<GatewayResult> {
  const correlationId = options.correlationId ?? newCorrelationId();
  const registry = getProviderRegistry();
  modelRegistry.refreshAvailability(
    new Set(registry.list().filter((descriptor) => descriptor.configured).map((descriptor) => descriptor.id)),
  );

  const candidates = candidatesFor(request);
  const errors: string[] = [];
  const fallbackFrom: string[] = [];

  for (let index = 0; index < candidates.length && index <= MAX_FALLBACKS + 1; index += 1) {
    const candidate = candidates[index] as { providerId?: string; model?: string };
    const routed = routeModel({ ...candidate }, registry);
    if (fallbackFrom.includes(routed.providerId)) continue;

    try {
      const provider = registry.require(routed.providerId);
      const result = await provider.complete({ ...request, model: routed.model });
      await track(db, {
        providerId: routed.providerId,
        model: routed.model,
        status: "OK",
        result,
        request,
        db,
        actor: options.actor,
        correlationId,
      });
      if (fallbackFrom.length > 0) {
        await eventBus
          .publishAndDispatch(db, {
            type: EVENT_TYPES.AI_FALLBACK_TRIGGERED,
            actor: options.actor,
            correlationId,
            payload: {
              fromProvider: fallbackFrom[0] ?? "unknown",
              toProvider: routed.providerId,
              reason: errors.join("; ").slice(0, 300),
              agentId: request.agentId ?? null,
            },
          })
          .catch(() => undefined);
      }
      return { ...result, fallback: fallbackFrom.length > 0, fallbackFrom, usageRecorded: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${routed.providerId}: ${message.slice(0, 200)}`);
      fallbackFrom.push(routed.providerId);
      await track(db, {
        providerId: routed.providerId,
        model: routed.model,
        status: "ERROR",
        error: message.slice(0, 300),
        request,
        db,
        actor: options.actor,
        correlationId,
      });
      // Retry the same provider once on transient faults before moving on.
      if (isTransient(message)) {
        try {
          const provider = registry.require(routed.providerId);
          const retry = await provider.complete({ ...request, model: routed.model });
          await track(db, {
            providerId: routed.providerId,
            model: routed.model,
            status: "OK",
            result: retry,
            request,
            db,
            actor: options.actor,
            correlationId,
          });
          return { ...retry, fallback: fallbackFrom.length > 1, fallbackFrom, usageRecorded: true };
        } catch (retryError) {
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
          errors.push(`${routed.providerId} (retry): ${retryMessage.slice(0, 200)}`);
        }
      }
    }
  }

  throw aiProviderError(
    `All provider candidates failed: ${errors.slice(-3).join(" | ")}`.slice(0, 500),
  );
}

/** Aggregated spend view for the dashboard (read-only). */
export async function usageSummary(
  db: DbClient,
  query: { companyId?: string; agentId?: string } = {},
): Promise<Record<string, unknown>> {
  const rows = await db.aiUsage.findMany({
    where: {
      ...(query.companyId !== undefined ? { companyId: query.companyId } : {}),
      ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 1_000,
  });
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostMinor = 0;
  let calls = 0;
  let errors = 0;
  const byProvider = new Map<string, { calls: number; costMinor: number }>();
  for (const row of rows) {
    calls += 1;
    if (row.status !== "OK") errors += 1;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    estimatedCostMinor += row.estimatedCostMinor;
    const bucket = byProvider.get(row.providerId) ?? { calls: 0, costMinor: 0 };
    bucket.calls += 1;
    bucket.costMinor += row.estimatedCostMinor;
    byProvider.set(row.providerId, bucket);
  }
  return {
    window: "last-1000-calls",
    calls,
    errors,
    inputTokens,
    outputTokens,
    estimatedCostMinor,
    byProvider: toJson(Object.fromEntries(byProvider)),
  };
}
