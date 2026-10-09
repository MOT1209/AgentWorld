/**
 * AI platform integrity tests (Agent 2 ownership).
 *
 * These lock in three repairs that make the documented gateway contract true
 * rather than aspirational:
 *
 *   1. The agent runtime's own thinking calls go through the AI Gateway, so
 *      every model call is routed, tracked and costed -- it never dials a
 *      vendor adapter directly.
 *   2. A pinned *real* provider is never silently answered by the scripted
 *      mock stand-in; an outage is an error the run reports.
 *   3. Estimated AI cost actually reaches the ledger (type FEE) above the
 *      configured threshold, keyed by the usage row so a replay cannot
 *      double-charge.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { createTestUser, createTestAgent, unique, SYSTEM, CORRELATION } from "./helpers.js";
import { resetConfigCache, Money } from "../packages/shared/src/index.js";
import {
  complete,
  resetGatewayCaches,
  chargeAiSpend,
  MockProvider,
  ProviderRegistry,
  type AIProvider,
  type CompletionRequest,
  type CompletionResult,
  type ProviderDescriptor,
  type ProviderKind,
} from "../packages/ai/src/index.js";
import { runAgent, type ToolInvoker } from "../packages/agents/src/index.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { deposit } from "../packages/economy/src/ledger.service.js";
import { verifyLedger } from "../packages/economy/src/statements.js";

/** A provider that always answers with a fixed, sizable usage footprint. */
class ScriptedUsageProvider implements AIProvider {
  readonly kind: ProviderKind = "OPENAI_COMPATIBLE";
  readonly id: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  calls = 0;

  constructor(id: string, promptTokens: number, completionTokens: number) {
    this.id = id;
    this.promptTokens = promptTokens;
    this.completionTokens = completionTokens;
  }

  isAvailable(): boolean {
    return true;
  }

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.id,
      configured: true,
      defaultModel: "gpt-4o",
      models: ["gpt-4o"],
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls += 1;
    return {
      content: "scripted reply",
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: this.promptTokens, completionTokens: this.completionTokens },
      providerId: this.id,
      model: request.model,
      latencyMs: 1,
    };
  }
}

/** A reachable provider whose upstream always fails with a transient error. */
class FailingProvider implements AIProvider {
  readonly kind: ProviderKind = "OPENAI_COMPATIBLE";
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }

  isAvailable(): boolean {
    return true;
  }

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.id,
      configured: true,
      defaultModel: "gpt-4o",
      models: ["gpt-4o"],
    };
  }

  async complete(): Promise<CompletionResult> {
    throw new Error("upstream 503 service unavailable");
  }
}

afterAll(() => {
  delete process.env.AI_CHARGE_THRESHOLD_MINOR;
  resetGatewayCaches();
  resetConfigCache();
});

describe("agent runtime is routed through the AI gateway", () => {
  it("records an AiUsage row for the agent's own thinking call", async () => {
    const agent = await createTestAgent();
    const invoker: ToolInvoker = {
      listSpecs: () => [],
      invoke: async (name) => ({ status: "SUCCESS", toolName: name, durationMs: 0, data: {} }),
    };

    const before = await prisma.aiUsage.count({ where: { agentId: agent.id } });
    const result = await runAgent(
      { agentId: agent.id, trigger: "MANUAL" },
      { db: prisma, invoker, providerRegistry: new ProviderRegistry([new MockProvider()]) },
    );

    expect(result.outcome).toBe("COMPLETED");
    expect(result.providerId).toBe("mock");
    const after = await prisma.aiUsage.count({ where: { agentId: agent.id } });
    expect(after).toBe(before + 1);

    const usage = await prisma.aiUsage.findFirstOrThrow({
      where: { agentId: agent.id },
      orderBy: { id: "desc" },
    });
    expect(usage.providerId).toBe("mock");
    expect(usage.status).toBe("OK");
    expect(usage.correlationId).not.toBeNull();
  });
});

describe("bounded fallback is honest about the mock stand-in", () => {
  it("falls back to the mock provider by default and says so", async () => {
    const registry = new ProviderRegistry([new MockProvider(), new FailingProvider("openai-compatible")]);
    const result = await complete(
      prisma,
      { model: "gpt-4o", providerId: "openai-compatible", messages: [{ role: "user", content: "hi" }] },
      { actor: SYSTEM, correlationId: CORRELATION, registry },
    );
    expect(result.providerId).toBe("mock");
    expect(result.fallback).toBe(true);
    expect(result.fallbackFrom).toContain("openai-compatible");
  });

  it("refuses to answer a pinned real provider with a script regardless", async () => {
    const registry = new ProviderRegistry([new MockProvider(), new FailingProvider("openai-compatible")]);
    await expect(
      complete(
        prisma,
        {
          model: "gpt-4o",
          providerId: "openai-compatible",
          allowMockFallback: false,
          messages: [{ role: "user", content: "hi" }],
        },
        { actor: SYSTEM, correlationId: CORRELATION, registry },
      ),
    ).rejects.toThrow(/All provider candidates failed/);
  });
});

describe("AI cost reaches the ledger", () => {
  async function companyWithTreasury(minor: number): Promise<{ companyId: string; walletId: string }> {
    const user = await createTestUser();
    const company = await prisma.company.create({
      data: { name: unique("AI Cost Co"), ownerId: user.id },
    });
    const wallet = await ensureWallet(prisma, { ownerType: "COMPANY", ownerId: company.id });
    await deposit({
      toWalletId: wallet.id,
      amount: Money.fromMinor(minor, wallet.currency),
      description: "test treasury funding",
      actor: SYSTEM,
      correlationId: CORRELATION,
    });
    return { companyId: company.id, walletId: wallet.id };
  }

  it("charges the company treasury above the threshold, once per call", async () => {
    const { companyId, walletId } = await companyWithTreasury(200_000);
    const provider = new ScriptedUsageProvider("openai-compatible", 50_000, 50_000);

    process.env.AI_CHARGE_THRESHOLD_MINOR = "500";
    resetConfigCache();
    resetGatewayCaches();
    try {
      // 50k input at 2/1k + 50k output at 8/1k = 500 minor units.
      const result = await complete(
        prisma,
        {
          model: "gpt-4o",
          providerId: "openai-compatible",
          messages: [{ role: "user", content: "hello" }],
          companyId,
        },
        { actor: SYSTEM, correlationId: CORRELATION, registry: new ProviderRegistry([provider]) },
      );
      expect(result.providerId).toBe("openai-compatible");

      const usage = await prisma.aiUsage.findFirstOrThrow({ where: { companyId }, orderBy: { id: "desc" } });
      expect(usage.estimatedCostMinor).toBe(500);

      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
      expect(wallet.balanceMinor).toBe(199_500);

      const fee = await prisma.transaction.findFirst({
        where: { walletId, type: "FEE", direction: "DEBIT" },
      });
      expect(fee).not.toBeNull();
      expect(fee?.amountMinor).toBe(500);

      const report = await verifyLedger(prisma, [walletId]);
      expect(report.problems).toEqual([]);
    } finally {
      delete process.env.AI_CHARGE_THRESHOLD_MINOR;
      resetConfigCache();
      resetGatewayCaches();
    }
  });

  it("replays a repeated charge as a ledger no-op", async () => {
    const { companyId, walletId } = await companyWithTreasury(200_000);

    process.env.AI_CHARGE_THRESHOLD_MINOR = "500";
    resetConfigCache();
    try {
      const first = await chargeAiSpend(prisma, {
        companyId,
        amountMinor: 1_000,
        idempotencyKey: "ai-usage:test-replay",
        correlationId: CORRELATION,
      });
      expect(first?.chargedMinor).toBe(1_000);

      const second = await chargeAiSpend(prisma, {
        companyId,
        amountMinor: 1_000,
        idempotencyKey: "ai-usage:test-replay",
        correlationId: CORRELATION,
      });
      expect(second).toBeNull();

      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
      expect(wallet.balanceMinor).toBe(199_000);
      const fees = await prisma.transaction.count({ where: { walletId, type: "FEE", direction: "DEBIT" } });
      expect(fees).toBe(1);
    } finally {
      delete process.env.AI_CHARGE_THRESHOLD_MINOR;
      resetConfigCache();
    }
  });

  it("never charges below the configured threshold", async () => {
    const { companyId, walletId } = await companyWithTreasury(200_000);
    // Default threshold is 1,000,000 minor units; 1,000 must not move money.
    const charged = await chargeAiSpend(prisma, {
      companyId,
      amountMinor: 1_000,
      idempotencyKey: "ai-usage:below-threshold",
      correlationId: CORRELATION,
    });
    expect(charged).toBeNull();
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    expect(wallet.balanceMinor).toBe(200_000);
  });
});
