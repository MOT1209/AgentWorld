import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { Money } from "../packages/shared/src/index.js";
import { createDefaultRegistry, ToolExecutor } from "../packages/tools/src/index.js";
import { roleProfiles } from "../packages/agents/src/role-profiles.js";
import { getProviderRegistry, ensureMockProvider } from "../packages/ai/src/index.js";
import {
  requestApproval,
  decideApproval,
  listApprovals,
  readApprovalPayload,
  claimForExecution,
} from "../packages/approvals/src/index.js";
import { SYSTEM, CORRELATION, createTestAgent } from "./helpers.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { deposit } from "../packages/economy/src/ledger.service.js";
import type { Permission } from "../packages/security/src/permissions.js";

function executorWith(perms: Permission[], agentId?: string): { executor: ToolExecutor; ctx: Parameters<ToolExecutor["invoke"]>[2] } {
  const registry = createDefaultRegistry();
  const executor = new ToolExecutor({ registry });
  return {
    executor,
    ctx: {
      ...(agentId !== undefined ? { agentId } : {}),
      actor: agentId !== undefined ? { actorType: "AGENT" as const, actorId: agentId } : SYSTEM,
      correlationId: CORRELATION,
      permissions: new Set(perms),
      db: prisma,
      now: new Date(),
    },
  };
}

describe("tool permissions", () => {
  it("denies tools without the required permission", async () => {
    const a = await createTestAgent({ name: "NoPerms" });
    const { executor, ctx } = executorWith([], a.id);
    const result = await executor.invoke("task.list", { limit: 5 }, ctx);
    expect(result.status).toBe("DENIED");
  });

  it("refuses humanOnly tools for agents", async () => {
    const a = await createTestAgent({ name: "HumanOnly" });
    const { executor, ctx } = executorWith(["approval.decide" as Permission], a.id);
    const result = await executor.invoke("approval.decide", { approvalRequestId: "x", decision: "APPROVED" }, ctx);
    expect(result.status).toBe("DENIED");
  });

  it("rejects invalid arguments via Zod", async () => {
    const a = await createTestAgent({ name: "BadArgs" });
    const { executor, ctx } = executorWith(["task.read" as Permission], a.id);
    const result = await executor.invoke("task.list", { limit: 9999 }, ctx);
    expect(result.status).toBe("ERROR");
  });

  it("holds large transfers for approval", async () => {
    const a = await createTestAgent({ name: "BigSpender", roleKey: "EXECUTOR" });
    const b = await createTestAgent({ name: "Receiver" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    await deposit({
      toWalletId: wa.id,
      amount: Money.fromMinor(5_000_00, "KW"),
      description: "fund",
      actor: SYSTEM,
      correlationId: CORRELATION,
    });
    const profile = await import("../packages/agents/src/agent.service.js").then((m) =>
      m.buildRuntimeProfile(prisma, a.id),
    );
    const { executor, ctx } = executorWith([...profile.effectivePermissions], a.id);
    const result = await executor.invoke(
      "wallet.transfer",
      { toAgentId: b.id, amount: "2000.00", description: "big move" },
      { ...ctx, companyId: undefined },
    );
    expect(result.status).toBe("PENDING_APPROVAL");
    expect(result.approvalRequestId).toBeDefined();
  });
});

describe("roles and approvals", () => {
  it("rejects human-only permission grants in the role registry", () => {
    expect(() =>
      roleProfiles.register({
        roleKey: "EVIL",
        displayName: "Evil",
        description: "tries to grab human powers",
        systemPromptFragments: ["x"],
        behaviouralRules: ["y"],
        permissions: ["approval.decide" as never],
        allowedTools: "*",
        maxIterations: 2,
      }),
    ).toThrow();
  });

  it("freezes payloads and single-flights execution claims", async () => {
    const a = await createTestAgent({ name: "Requester" });
    const request = await requestApproval(
      prisma,
      {
        action: "wallet.transfer",
        actionPayload: { amount: "10.00" },
        reason: "needs a human to confirm this test transfer",
        risk: "HIGH",
        requester: { actorType: "AGENT", actorId: a.id },
        requesterAgentId: a.id,
        toolName: "wallet.transfer",
        agentId: a.id,
      },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    const payload = readApprovalPayload(request);
    expect(payload.toolName).toBe("wallet.transfer");

    const owner = await prisma.user.create({
      data: {
        email: `decider-${Date.now()}@test.local`,
        passwordHash: "x".repeat(60),
        displayName: "Decider",
        role: "OWNER",
      },
    });
    const decided = await decideApproval(
      prisma,
      { requestId: request.id, decision: "APPROVED", decidedByUserId: owner.id },
      { actor: { actorType: "USER", actorId: owner.id }, correlationId: CORRELATION, permissions: new Set<Permission>(["approval.decide"]) },
    );
    expect(decided.status).toBe("APPROVED");

    const first = await claimForExecution(prisma, request.id);
    expect(first).not.toBeNull();
    const second = await claimForExecution(prisma, request.id);
    expect(second).toBeNull();

    const pending = await listApprovals(prisma, { status: "PENDING" });
    expect(pending.every((p) => p.id !== request.id)).toBe(true);
  });
});

describe("ai providers", () => {
  it("runs deterministically on mock and swaps provider selection", async () => {
    ensureMockProvider("mock");
    const registry = getProviderRegistry();
    const provider = registry.require("mock");
    const first = await provider.complete({
      model: "mock-1",
      messages: [{ role: "user", content: "plan the week" }],
      temperature: 0,
      maxTokens: 64,
    });
    const second = await provider.complete({
      model: "mock-1",
      messages: [{ role: "user", content: "plan the week" }],
      temperature: 0,
      maxTokens: 64,
    });
    expect(first.content).toBe(second.content);

    const a = await createTestAgent({ name: "Swap Provider" });
    await prisma.agent.update({ where: { id: a.id }, data: { providerId: "mock", model: "mock-1" } });
    const updated = await prisma.agent.findUniqueOrThrow({ where: { id: a.id } });
    expect(updated.providerId).toBe("mock");
  });
});
