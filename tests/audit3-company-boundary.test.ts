import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { createDefaultRegistry, ToolExecutor } from "../packages/tools/src/index.js";
import { raiseEscalation } from "../packages/orchestration/src/index.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { PERMISSIONS } from "../packages/security/src/permissions.js";
import { SYSTEM, CORRELATION, createTestAgent, createTestUser, fundAgentWallet, unique } from "./helpers.js";

// Third pass (2026-10-12). Agent-originated actions must stay inside the
// agent's own company:
//   AW-24  role-addressed messages and automatic escalation routing looked
//          agents up by role across EVERY company
//   AW-25  wallet.transfer paid any string id: nonexistent agents (money
//          into a wallet nobody controls) and other companies' agents,
//          with no approval below the spend threshold
// Each test below failed against the code as it stood before the fix.

const executor = new ToolExecutor({ registry: createDefaultRegistry() });

function agentCtx(agentId: string, companyId: string | null, permissions: string[]) {
  return {
    agentId,
    actor: { actorType: "AGENT" as const, actorId: agentId },
    correlationId: CORRELATION,
    permissions: new Set<string>(permissions),
    db: prisma,
    now: new Date(),
    ...(companyId !== null ? { companyId } : {}),
  };
}

/** Two companies. Company A's agents are created first, so any "oldest match anywhere" lookup picks A. */
async function twoCompanies() {
  const owner = await createTestUser();
  const a = await prisma.company.create({ data: { name: unique("BoundaryA"), ownerId: owner.id } });
  const b = await prisma.company.create({ data: { name: unique("BoundaryB"), ownerId: owner.id } });
  const aPlanner = await createTestAgent({ roleKey: "PLANNER", companyId: a.id });
  const aExec = await createTestAgent({ roleKey: "EXECUTOR", companyId: a.id });
  const bPlanner = await createTestAgent({ roleKey: "PLANNER", companyId: b.id });
  const bExec = await createTestAgent({ roleKey: "EXECUTOR", companyId: b.id });
  return { owner, a, b, aPlanner, aExec, bPlanner, bExec };
}

const SEND = [PERMISSIONS.MESSAGE_SEND];
const TRANSFER = [PERMISSIONS.WALLET_TRANSFER];

async function conversationsOf(agentId: string): Promise<number> {
  return prisma.conversation.count({ where: { participants: { some: { agentId } } } });
}

async function balanceOf(agentId: string): Promise<number> {
  const wallet = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: agentId });
  return (await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceMinor;
}

describe("AW-24: escalation routing stays inside the raiser's company", () => {
  it("routes to the raiser's own company supervisor, not the oldest one anywhere", async () => {
    const w = await twoCompanies();
    const escalation = await raiseEscalation(
      prisma,
      { fromAgentId: w.bExec.id, category: "BLOCKED", detail: "Cannot continue without the staging credentials" },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    expect(escalation.toAgentId).toBe(w.bPlanner.id);
    expect(escalation.toAgentId).not.toBe(w.aPlanner.id);
  });

  it("goes to a human when the raiser's company has no supervisor, never to another company's", async () => {
    const w = await twoCompanies();
    const owner = await createTestUser();
    const lonely = await prisma.company.create({ data: { name: unique("Lonely"), ownerId: owner.id } });
    const loneExec = await createTestAgent({ roleKey: "EXECUTOR", companyId: lonely.id });
    const escalation = await raiseEscalation(
      prisma,
      { fromAgentId: loneExec.id, category: "BLOCKED", detail: "Nobody here can unblock this task" },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    expect(escalation.toAgentId).toBeNull();
    expect([w.aPlanner.id, w.bPlanner.id]).not.toContain(escalation.toAgentId);
  });
});

describe("AW-24: message.send recipients stay inside the sender's company", () => {
  it("a role address never reaches another company's agents", async () => {
    const w = await twoCompanies();
    const result = await executor.invoke("message.send", { to: "EXECUTOR", content: "status?" }, agentCtx(w.aExec.id, w.a.id, SEND) as never);
    // The only other EXECUTOR is company B's: there is nobody to deliver to.
    expect(result.status).not.toBe("SUCCESS");
    expect(await conversationsOf(w.bExec.id), "no thread may be opened with another company's agent").toBe(0);
  });

  it("a role address still reaches the sender's own colleagues (control)", async () => {
    const w = await twoCompanies();
    const colleague = await createTestAgent({ roleKey: "EXECUTOR", companyId: w.a.id });
    const result = await executor.invoke("message.send", { to: "EXECUTOR", content: "status?" }, agentCtx(w.aExec.id, w.a.id, SEND) as never);
    expect(result.status).toBe("SUCCESS");
    const delivered = (result.data as { deliveredTo: Array<{ agentId: string }> }).deliveredTo.map((row) => row.agentId);
    expect(delivered).toEqual([colleague.id]);
  });

  it("an explicit agent id of another company is refused", async () => {
    const w = await twoCompanies();
    const result = await executor.invoke("message.send", { to: w.bExec.id, content: "psst" }, agentCtx(w.aExec.id, w.a.id, SEND) as never);
    expect(result.status).not.toBe("SUCCESS");
    expect(await conversationsOf(w.bExec.id)).toBe(0);
  });

  it("an explicit agent id of a colleague still works (control)", async () => {
    const w = await twoCompanies();
    const result = await executor.invoke("message.send", { to: w.aPlanner.id, content: "plan ready" }, agentCtx(w.aExec.id, w.a.id, SEND) as never);
    expect(result.status).toBe("SUCCESS");
  });
});

describe("AW-25: wallet.transfer validates its recipient", () => {
  it("refuses a recipient id that is not an agent, and creates no wallet for it", async () => {
    const w = await twoCompanies();
    await fundAgentWallet(w.aExec.id, 50_000);
    const phantom = `cx${unique("phantom").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(22, "0")}`;
    const before = await balanceOf(w.aExec.id);

    const result = await executor.invoke(
      "wallet.transfer",
      { toAgentId: phantom, amount: "5.00", idempotencyKey: unique("phantom-pay") },
      agentCtx(w.aExec.id, w.a.id, TRANSFER) as never,
    );

    expect(result.status).not.toBe("SUCCESS");
    expect(await balanceOf(w.aExec.id), "no money may leave the sender").toBe(before);
    expect(await prisma.wallet.count({ where: { ownerId: phantom } }), "no wallet may be minted for an unknown id").toBe(0);
  });

  it("holds a transfer to another company's agent for human approval, even far below the spend threshold", async () => {
    const w = await twoCompanies();
    await fundAgentWallet(w.aExec.id, 50_000);
    const before = await balanceOf(w.aExec.id);
    const victimBefore = await balanceOf(w.bExec.id);

    const result = await executor.invoke(
      "wallet.transfer",
      { toAgentId: w.bExec.id, amount: "1.00", idempotencyKey: unique("cross-pay") },
      agentCtx(w.aExec.id, w.a.id, TRANSFER) as never,
    );

    expect(result.status).toBe("PENDING_APPROVAL");
    expect(await balanceOf(w.aExec.id)).toBe(before);
    expect(await balanceOf(w.bExec.id)).toBe(victimBefore);
  });

  it("still pays a colleague in the same company without approval (control)", async () => {
    const w = await twoCompanies();
    await fundAgentWallet(w.aExec.id, 50_000);
    const before = await balanceOf(w.aExec.id);

    const result = await executor.invoke(
      "wallet.transfer",
      { toAgentId: w.aPlanner.id, amount: "1.00", idempotencyKey: unique("same-pay") },
      agentCtx(w.aExec.id, w.a.id, TRANSFER) as never,
    );

    expect(result.status).toBe("SUCCESS");
    expect(await balanceOf(w.aExec.id)).toBe(before - 100);
  });
});

// AW-26: the URL probe behind testing.run (suite BROWSER/E2E with a url) fetched
// whatever http(s) URL it was given from the API host, with no outbound guard.
// An agent holding testing.run could probe cloud metadata and internal ports,
// and the failure text told it which ports were open. In production it now goes
// through the same assertPublicUrl guard as webhooks and connectors.
describe("AW-26: testing.run URL probe honours the outbound guard in production", () => {
  const PRODUCTION_ENV: Record<string, string> = {
    NODE_ENV: "production",
    JWT_SECRET: "j".repeat(48),
    SEED_OWNER_PASSWORD: "Not-The-Default-Seed-1",
    EXEC_SANDBOX: "docker",
  };

  async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
    const { resetConfigCache } = await import("../packages/shared/src/index.js");
    const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    resetConfigCache();
    try {
      return await run();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetConfigCache();
    }
  }

  it("refuses loopback, private and metadata targets in production and never calls fetch", async () => {
    const { vi } = await import("vitest");
    const agent = await createTestAgent({ roleKey: "EXECUTOR" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await withEnv(PRODUCTION_ENV, async () => {
        for (const url of ["http://127.0.0.1:4000/health", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://[::1]/"]) {
          const result = await executor.invoke(
            "testing.run",
            { suite: "BROWSER", url },
            agentCtx(agent.id, null, [PERMISSIONS.TESTING_RUN]) as never,
          );
          expect(result.status, url).not.toBe("SUCCESS");
        }
      });
      expect(fetchSpy, "no request may leave the server for a refused URL").not.toHaveBeenCalled();
      expect(await prisma.testRun.count({ where: { agentId: agent.id } })).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("still probes a local service outside production, so development smoke tests keep working (control)", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => res.writeHead(200).end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const agent = await createTestAgent({ roleKey: "EXECUTOR" });
      const result = await executor.invoke(
        "testing.run",
        { suite: "BROWSER", url: `http://127.0.0.1:${port}/` },
        agentCtx(agent.id, null, [PERMISSIONS.TESTING_RUN]) as never,
      );
      expect(result.status).toBe("SUCCESS");
      expect((result.data as { status: string }).status).toBe("PASSED");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
