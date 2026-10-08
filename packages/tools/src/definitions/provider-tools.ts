/**
 * AI provider gateway tools.
 *
 * `provider.complete` is the ONLY way an agent reaches a model through the
 * gateway: routing, fallback, usage tracking and cost accounting all happen in
 * one governed place. Listing models/provider status is read-only and reveals
 * no credentials.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import type { ToolDefinition } from "../types.js";
import { complete, usageSummary } from "../../../ai/src/index.js";
import { modelRegistry } from "../../../ai/src/index.js";
import { getProviderRegistry, describeVendorCatalog } from "../../../ai/src/index.js";
import { SYSTEM_ACTOR, actorSystem } from "../../../shared/src/index.js";

export const providerListTool: ToolDefinition<Record<string, never>> = {
  name: "provider.list",
  description:
    "List the configured AI providers and the model catalogue with capabilities, context windows and estimated costs. Reveals no credentials.",
  inputSchema: z.object({}),
  requiredPermission: PERMISSIONS.PROVIDER_READ,
  risk: "LOW",
  async execute() {
    const registry = getProviderRegistry();
    modelRegistry.refreshAvailability(
      new Set(registry.list().filter((d) => d.configured).map((d) => d.id)),
    );
    return {
      data: {
        providers: registry.list().map((descriptor) => ({
          id: descriptor.id,
          kind: descriptor.kind,
          displayName: descriptor.displayName,
          configured: descriptor.configured,
          defaultModel: descriptor.defaultModel,
        })),
        models: modelRegistry.list().map((model) => ({
          providerId: model.providerId,
          modelId: model.modelId,
          displayName: model.displayName,
          capabilities: model.capabilities,
          contextWindow: model.contextWindow,
          available: model.available,
        })),
        catalog: describeVendorCatalog(),
      },
      summary: `${registry.list().length} providers, ${modelRegistry.list().length} models catalogued`,
    };
  },
};

export const providerCompleteTool: ToolDefinition<{
  prompt: string;
  modelId?: string;
  providerId?: string;
  capability?: string;
  maxTokens?: number;
  maxCostPer1k?: number;
  minContextWindow?: number;
}> = {
  name: "provider.complete",
  description:
    "Run a one-shot completion through the AI Provider Gateway with fallback and usage tracking. Use for subtasks like summarising or classifying; your own thinking does not need this tool.",
  inputSchema: z.object({
    prompt: z.string().min(1).max(8_000),
    modelId: z.string().max(100).optional(),
    providerId: z.string().max(60).optional(),
    capability: z.string().max(40).optional(),
    maxTokens: z.number().int().min(16).max(4_096).optional(),
    maxCostPer1k: z.number().int().min(0).max(1_000_000).optional(),
    minContextWindow: z.number().int().min(1_024).max(10_000_000).optional(),
  }),
  requiredPermission: PERMISSIONS.PROVIDER_USE,
  risk: "MEDIUM",
  async execute(context, input) {
    const result = await complete(
      context.db,
      {
        model: input.modelId ?? "",
        messages: [{ role: "user", content: input.prompt }],
        maxTokens: input.maxTokens,
        routing: {
          ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
          ...(input.modelId !== undefined ? { model: input.modelId } : {}),
          ...(input.capability !== undefined ? { capability: input.capability } : {}),
          ...(input.maxCostPer1k !== undefined ? { maxCostPer1k: input.maxCostPer1k } : {}),
          ...(input.minContextWindow !== undefined ? { minContextWindow: input.minContextWindow } : {}),
        },
        agentId: context.agentId ?? null,
        companyId: context.companyId ?? null,
      },
      { actor: context.actor, correlationId: context.correlationId },
    );
    return {
      data: {
        content: result.content,
        providerId: result.providerId,
        model: result.model,
        fallback: result.fallback,
        usage: result.usage ?? null,
      },
      summary: `Completed via ${result.providerId}/${result.model}${result.fallback ? " (fallback)" : ""}`,
    };
  },
};

export const providerUsageTool: ToolDefinition<{ agentId?: string }> = {
  name: "provider.usage",
  description: "Show AI usage and estimated cost totals (own usage, or a company-wide read for permitted callers).",
  inputSchema: z.object({
    agentId: z.string().max(100).optional(),
  }),
  requiredPermission: PERMISSIONS.PROVIDER_READ,
  risk: "LOW",
  async execute(context, input) {
    const summary = await usageSummary(context.db, {
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(context.companyId !== undefined ? { companyId: context.companyId } : {}),
    });
    return { data: summary, summary: `${String(summary.calls)} calls tracked` };
  },
};

export const providerTools = [providerListTool, providerCompleteTool, providerUsageTool];
export { SYSTEM_ACTOR, actorSystem };
