import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { prisma } from "../packages/database/src/client.js";
import { ToolExecutor, ToolRegistry } from "../packages/tools/src/index.js";
import {
  claimForExecution,
  markExecutionFailed,
  markExecutionUncertain,
  requestApproval,
} from "../packages/approvals/src/index.js";
import { getConfig, resetConfigCache } from "../packages/shared/src/index.js";
import { createApp } from "../apps/api/src/app.js";
import { SYSTEM, CORRELATION } from "./helpers.js";
import type { Permission } from "../packages/security/src/permissions.js";

describe("failures that may have partly executed", () => {
  const registry = new ToolRegistry().register({
    name: "test.explode",
    description: "Throws inside the handler.",
    inputSchema: z.object({ n: z.number() }),
    requiredPermission: "task.read" as Permission,
    risk: "LOW",
    async execute() {
      throw new Error("boom after partial work");
    },
  } as never);
  const executor = new ToolExecutor({ registry });
  const ctx = {
    actor: SYSTEM,
    correlationId: CORRELATION,
    permissions: new Set<Permission>(["task.read" as Permission]),
    db: prisma,
    now: new Date(),
  };

  it("flags handler failures, but not validation or permission failures", async () => {
    // isApprovalReplay: the handler only runs for approved/known actions.
    const handlerFailure = await executor.invoke("test.explode", { n: 1 }, { ...ctx, isApprovalReplay: true });
    expect(handlerFailure.status).toBe("ERROR");
    expect(handlerFailure.sideEffectsPossible).toBe(true);

    const invalid = await executor.invoke("test.explode", { n: "not-a-number" }, ctx);
    expect(invalid.status).toBe("ERROR");
    expect(invalid.sideEffectsPossible).toBeUndefined();

    const denied = await executor.invoke("test.explode", { n: 1 }, { ...ctx, permissions: new Set<Permission>() });
    expect(denied.status).toBe("DENIED");
    expect(denied.sideEffectsPossible).toBeUndefined();
  });

  async function approvedRequest(): Promise<string> {
    const request = await requestApproval(
      prisma,
      {
        action: "wallet.transfer",
        actionPayload: { amount: "10.00" },
        reason: "needs a human to confirm this test transfer",
        risk: "HIGH",
        requester: SYSTEM,
        toolName: "wallet.transfer",
      },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    await prisma.approvalRequest.update({ where: { id: request.id }, data: { status: "APPROVED" } });
    return request.id;
  }

  it("keeps the claim after an uncertain failure, releases it after a pre-execution one", async () => {
    const uncertain = await approvedRequest();
    expect(await claimForExecution(prisma, uncertain)).not.toBeNull();
    await markExecutionUncertain(prisma, uncertain, "boom after partial work");
    expect(await claimForExecution(prisma, uncertain)).toBeNull();
    const row = await prisma.approvalRequest.findUnique({ where: { id: uncertain } });
    expect(row?.executionError).toMatch(/partially completed; not retryable/);

    const refused = await approvedRequest();
    expect(await claimForExecution(prisma, refused)).not.toBeNull();
    await markExecutionFailed(prisma, refused, "Missing permission");
    expect(await claimForExecution(prisma, refused)).not.toBeNull();
  });
});

describe("TRUST_PROXY", () => {
  const saved = process.env.TRUST_PROXY;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved;
    resetConfigCache();
  });

  it("is off by default and an exact hop count when set", () => {
    delete process.env.TRUST_PROXY;
    resetConfigCache();
    expect(getConfig().trustProxy).toBe(0);
    expect(createApp().get("trust proxy")).toBeFalsy();

    process.env.TRUST_PROXY = "1";
    resetConfigCache();
    expect(createApp().get("trust proxy")).toBe(1);
  });

  it("rejects an out-of-range hop count", () => {
    process.env.TRUST_PROXY = "999";
    resetConfigCache();
    expect(() => getConfig()).toThrow();
  });
});
