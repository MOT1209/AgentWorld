import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import { signAccessToken } from "../packages/security/src/tokens.js";
import { evaluateCommand } from "../packages/tools/src/command-policy.js";
import { decideApproval, requestApproval } from "../packages/approvals/src/index.js";
import { buildPrincipal } from "../packages/security/src/rbac.js";
import { deposit, transfer, withdraw } from "../packages/economy/src/ledger.service.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { Money } from "../packages/shared/src/index.js";
import { handleMcpRequest } from "../packages/mcp/src/index.js";
import { createApiKey } from "../packages/security/src/api-keys.js";
import { readTextCapped } from "../packages/shared/src/net.js";
import { createTestAgent, SYSTEM, unique } from "./helpers.js";

// Regression tests for the defects confirmed in docs/audits/AGENTWORLD_AUDIT.md.
// Each block names the finding id it pins down.

const app = createApp();

async function makeUser(role: "OWNER" | "ADMIN" | "OBSERVER"): Promise<{ id: string; email: string; auth: string }> {
  const email = `${unique(role.toLowerCase())}@audit.test`.toLowerCase();
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword("TestPassword123", 10), displayName: role, role, isActive: true },
  });
  const token = signAccessToken({ userId: user.id, email, displayName: role, role });
  return { id: user.id, email, auth: `Bearer ${token}` };
}

describe("cross-company references the scope middleware used to miss", () => {
  let alice: Awaited<ReturnType<typeof makeUser>>; // ADMIN, owns A
  let bob: Awaited<ReturnType<typeof makeUser>>; // ADMIN, owns B
  let companyA: string;
  let companyB: string;
  let agentA: string;
  let agentB: string;

  beforeAll(async () => {
    alice = await makeUser("ADMIN");
    bob = await makeUser("ADMIN");
    const a = await request(app).post("/api/v1/companies").set("Authorization", alice.auth).send({ name: unique("Audit A") });
    const b = await request(app).post("/api/v1/companies").set("Authorization", bob.auth).send({ name: unique("Audit B") });
    companyA = a.body.data.id as string;
    companyB = b.body.data.id as string;
    agentA = (await createTestAgent({ companyId: companyA })).id;
    agentB = (await createTestAgent({ companyId: companyB })).id;
  });

  it("AW-01: an agent cannot be created inside an invisible company", async () => {
    const res = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", alice.auth)
      .send({
        name: unique("Smuggled"),
        roleKey: "EXECUTOR",
        title: "Spy",
        systemPrompt: "x",
        providerId: "mock",
        model: "mock-1",
        currentCompanyId: companyB,
      });
    expect(res.status).toBe(404);
    expect(await prisma.agent.count({ where: { currentCompanyId: companyB, title: "Spy" } })).toBe(0);
  });

  it("AW-01: an agent cannot be moved into an invisible company", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${agentA}`)
      .set("Authorization", alice.auth)
      .send({ currentCompanyId: companyB });
    expect(res.status).toBe(404);
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentA } });
    expect(row.currentCompanyId).toBe(companyA);

    // Moving within visible companies still works.
    const ok = await request(app)
      .patch(`/api/v1/agents/${agentA}`)
      .set("Authorization", alice.auth)
      .send({ currentCompanyId: companyA });
    expect(ok.status).toBe(200);
  });

  it("AW-02: a conversation cannot enlist another company's agent", async () => {
    const res = await request(app)
      .post("/api/v1/conversations")
      .set("Authorization", alice.auth)
      .send({ kind: "HUMAN_AGENT", title: "lure", participantAgentIds: [agentB] });
    expect(res.status).toBe(404);

    const mixed = await request(app)
      .post("/api/v1/conversations")
      .set("Authorization", alice.auth)
      .send({ kind: "AGENT_AGENT", title: "mixed", participantAgentIds: [agentA, agentB] });
    expect(mixed.status).toBe(404);

    const own = await request(app)
      .post("/api/v1/conversations")
      .set("Authorization", alice.auth)
      .send({ kind: "HUMAN_AGENT", title: "fine", participantAgentIds: [agentA] });
    expect(own.status).toBe(201);
  });

  it("AW-03: a verification report cannot read another company's execution jobs", async () => {
    const foreign = await prisma.executionJob.create({
      data: { kind: "COMMAND", status: "FAILED", command: JSON.stringify(["echo", "secret-b"]), agentId: agentB, error: "b-only detail" },
    });
    const res = await request(app)
      .post("/api/v1/executions/verify-report")
      .set("Authorization", alice.auth)
      .send({ jobIds: [foreign.id] });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("b-only detail");

    const own = await prisma.executionJob.create({
      data: { kind: "COMMAND", status: "COMPLETED", command: JSON.stringify(["echo", "a"]), agentId: agentA },
    });
    const ok = await request(app)
      .post("/api/v1/executions/verify-report")
      .set("Authorization", alice.auth)
      .send({ jobIds: [own.id] });
    expect(ok.status).toBe(201);
  });

  it("AW-03: an execution cannot be attached to another company's session", async () => {
    const session = await prisma.agentSession.create({ data: { agentId: agentB, providerId: "mock", model: "mock-1", status: "RUNNING" } });
    const res = await request(app)
      .post("/api/v1/executions")
      .set("Authorization", alice.auth)
      .send({ kind: "COMMAND", command: ["echo", "hi"], backendId: "mock", sessionId: session.id });
    expect(res.status).toBe(404);
  });
});

describe("AW-04: approval decisions are a single atomic transition", () => {
  it("lets exactly one of two concurrent decisions win", async () => {
    const human = await makeUser("OWNER");
    const principal = buildPrincipal({ id: human.id, email: human.email, displayName: "OWNER", role: "OWNER" });
    const ctx = { actor: SYSTEM, permissions: principal.permissions, userId: human.id };
    const pending = await requestApproval(
      prisma,
      { action: "wallet.transfer", actionPayload: { amount: 1 }, reason: "test", risk: "HIGH", requester: SYSTEM },
      ctx,
    );
    const results = await Promise.allSettled([
      decideApproval(prisma, { requestId: pending.id, decision: "REJECTED", decidedByUserId: human.id }, ctx),
      decideApproval(prisma, { requestId: pending.id, decision: "APPROVED", decidedByUserId: human.id }, ctx),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status;
    const stored = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } });
    // The row must say what the winning caller was told, never the loser's decision.
    expect(stored.status).toBe(winner);
  });
});

describe("AW-05: an idempotency key cannot be reused for a different movement", () => {
  it("refuses a transfer replay whose amount or destination differs", async () => {
    const from = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: (await createTestAgent()).id });
    const to = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: (await createTestAgent()).id });
    const other = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: (await createTestAgent()).id });
    await deposit({ toWalletId: from.id, amount: Money.fromMinor(10_000), description: "fund", actor: SYSTEM, correlationId: "aw05" });
    const key = unique("idem");
    const first = await transfer({ fromWalletId: from.id, toWalletId: to.id, amount: Money.fromMinor(100), description: "t", idempotencyKey: key, actor: SYSTEM, correlationId: "aw05" });
    expect(first.replayed).toBe(false);

    // Same request: a no-op replay.
    const same = await transfer({ fromWalletId: from.id, toWalletId: to.id, amount: Money.fromMinor(100), description: "t", idempotencyKey: key, actor: SYSTEM, correlationId: "aw05" });
    expect(same.replayed).toBe(true);

    await expect(
      transfer({ fromWalletId: from.id, toWalletId: to.id, amount: Money.fromMinor(999), description: "t", idempotencyKey: key, actor: SYSTEM, correlationId: "aw05" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      transfer({ fromWalletId: from.id, toWalletId: other.id, amount: Money.fromMinor(100), description: "t", idempotencyKey: key, actor: SYSTEM, correlationId: "aw05" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a single-wallet replay whose amount or direction differs", async () => {
    const wallet = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: (await createTestAgent()).id });
    const key = unique("idem-single");
    await deposit({ toWalletId: wallet.id, amount: Money.fromMinor(500), description: "d", idempotencyKey: key, actor: SYSTEM, correlationId: "aw05" });
    const again = await deposit({ toWalletId: wallet.id, amount: Money.fromMinor(500), description: "d", idempotencyKey: key, actor: SYSTEM, correlationId: "aw05" });
    expect(again.replayed).toBe(true);
    await expect(
      deposit({ toWalletId: wallet.id, amount: Money.fromMinor(501), description: "d", idempotencyKey: key, actor: SYSTEM, correlationId: "aw05" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      withdraw({ fromWalletId: wallet.id, amount: Money.fromMinor(500), description: "w", idempotencyKey: key, actor: SYSTEM, correlationId: "aw05" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("AW-06: command policy sees paths inside --opt=value arguments", () => {
  it("holds option values that point outside the workspace", () => {
    for (const argv of [
      ["git", "--git-dir=/home/other/.git", "log"],
      ["cp", "--target-directory=/tmp/out", "file.txt"],
      ["npm", "--prefix=../elsewhere", "install"],
      ["grep", "-r", "--file=C:\\secrets.txt", "."],
    ]) {
      expect(evaluateCommand(argv).verdict, argv.join(" ")).toBe("REQUIRE_APPROVAL");
    }
  });

  it("holds node loader flags that run code before the script", () => {
    for (const argv of [
      ["node", "--import=data:text/javascript,process.exit(1)", "app.js"],
      ["node", "--loader=./evil.mjs", "app.js"],
      ["node", "--experimental-loader", "./evil.mjs", "app.js"],
      ["node", "--import", "./evil.mjs", "app.js"],
    ]) {
      expect(evaluateCommand(argv).verdict, argv.join(" ")).toBe("REQUIRE_APPROVAL");
    }
  });

  it("still allows routine workspace-bounded commands", () => {
    for (const argv of [
      ["git", "log", "--format=%H"],
      ["node", "scripts/build.js"],
      ["npm", "test"],
      ["grep", "-r", "--include=*.ts", "TODO", "."],
    ]) {
      expect(evaluateCommand(argv).verdict, argv.join(" ")).toBe("ALLOW");
    }
  });
});

describe("AW-07: login does not reveal whether an account exists by timing", () => {
  it("spends a bcrypt comparison for unknown accounts too", async () => {
    const password = await import("../packages/security/src/password.js");
    expect(typeof password.verifyPasswordAgainstDummy).toBe("function");
    expect(password.verifyPasswordAgainstDummy("anything-123")).toBe(false);
  });
});

describe("AW-08: MCP tasks.create goes through the task engine with validated input", () => {
  it("rejects an unknown priority and emits TASK_CREATED for a valid call", async () => {
    const owner = await makeUser("OWNER");
    const ownerPrincipal = buildPrincipal({ id: owner.id, email: owner.email, displayName: "OWNER", role: "OWNER" });
    const { secret } = await createApiKey(
      prisma,
      { userId: owner.id, name: unique("mcp"), scopes: ["task.create"], ownerPermissions: ownerPrincipal.permissions },
      { actor: SYSTEM },
    );
    const company = await prisma.company.create({ data: { name: unique("MCP Co"), ownerId: owner.id } });

    const bad = await handleMcpRequest(
      { db: prisma, apiKey: secret, clientName: "test" },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks.create", arguments: { companyId: company.id, title: "x", priority: "ULTRA" } } },
    );
    expect(bad.error).toBeDefined();

    const good = await handleMcpRequest(
      { db: prisma, apiKey: secret, clientName: "test" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tasks.create", arguments: { companyId: company.id, title: "via mcp", priority: "HIGH" } } },
    );
    expect(good.error).toBeUndefined();
    const taskId = ((good.result as { structuredContent: { taskId: string } }).structuredContent).taskId;
    const event = await prisma.eventLog.findFirst({ where: { type: "TASK_CREATED", targetId: taskId } });
    expect(event).not.toBeNull();
  });
});

describe("AW-09: outbound response bodies are size-capped", () => {
  it("truncates a body larger than the cap without buffering all of it", async () => {
    const chunk = "x".repeat(1024);
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        if (produced > 10_000) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    const response = new Response(stream);
    const result = await readTextCapped(response, 4096);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(4096);
    expect(produced).toBeLessThan(100);
  });

  it("returns small bodies untouched", async () => {
    const result = await readTextCapped(new Response("hello"), 4096);
    expect(result).toEqual({ text: "hello", truncated: false });
  });
});

describe("AW-10: a skill approval is bound to its payload and single-use", () => {
  function manifest(key: string): Record<string, unknown> {
    return {
      key,
      name: `Skill ${key}`,
      description: "Moves money between wallets for the treasury team.",
      version: "1.0.0",
      author: "Acme",
      category: "finance",
      capabilities: ["operations"],
      permissions: ["workspace.read", "wallet.transfer"],
      tools: ["workspace.list"],
      dependencies: [],
      secretRequirements: [],
      network: { access: false, domains: [] },
      instructions: "Use the workspace tools to list files.",
      files: [],
    };
  }
  const install = (auth: string, key: string, approvalRequestId?: string) =>
    request(app)
      .post("/api/v1/skills/external/install")
      .set("Authorization", auth)
      .send({
        source: { type: "SKILLS_SH", identifier: key, version: "1.0.0" },
        externalId: key,
        manifest: manifest(key),
        ...(approvalRequestId !== undefined ? { approvalRequestId } : {}),
      });

  it("cannot unlock a different skill or be replayed", async () => {
    const owner = await makeUser("OWNER");
    const benign = unique("approved-skill");
    const other = unique("other-skill");

    const asked = await install(owner.auth, benign);
    expect(asked.status).toBe(202);
    const approvalId = asked.body.data.approvalRequestId as string;
    const decided = await request(app)
      .post(`/api/v1/approvals/${approvalId}/decision`)
      .set("Authorization", owner.auth)
      .send({ decision: "APPROVED", replay: false });
    expect(decided.status).toBe(200);

    // The approval for `benign` must not install `other`.
    const smuggled = await install(owner.auth, other, approvalId);
    expect(smuggled.status).toBe(202);

    const installed = await install(owner.auth, benign, approvalId);
    expect(installed.status).toBe(201);

    // Used once: presenting it again asks for a fresh approval.
    const replayed = await install(owner.auth, benign, approvalId);
    expect(replayed.status).toBe(202);
  });
});
