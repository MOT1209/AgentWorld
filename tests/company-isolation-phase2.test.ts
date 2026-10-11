import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import { signAccessToken } from "../packages/security/src/tokens.js";
import { authenticateApiKey, createApiKey } from "../packages/security/src/api-keys.js";
import { companyScope } from "../packages/security/src/company-access.js";
import { buildPrincipal } from "../packages/security/src/rbac.js";
import { scopedLogs } from "../apps/api/src/middleware/company-scope.js";
import { createTestAgent, unique, SYSTEM } from "./helpers.js";

// F4 phase 2: everything that reaches a company through an agent, task, plan
// or workspace follows that company's visibility.

const app = createApp();

async function makeUser(role: "OWNER" | "ADMIN" | "OBSERVER") {
  const email = `${unique(role.toLowerCase())}@iso2.test`.toLowerCase();
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword("TestPassword123", 10), displayName: role, role, isActive: true },
  });
  return { id: user.id, email, auth: `Bearer ${signAccessToken({ userId: user.id, email, displayName: role, role })}` };
}

describe("company isolation, phase 2", () => {
  let alice: Awaited<ReturnType<typeof makeUser>>;
  let bob: Awaited<ReturnType<typeof makeUser>>;
  let companyA: string;
  let companyB: string;
  let agentA: string;
  let agentB: string;
  let planB: string;
  let approvalB: string;
  let conversationB: string;
  let factoryB: string;

  beforeAll(async () => {
    alice = await makeUser("ADMIN");
    bob = await makeUser("ADMIN");
    companyA = (await prisma.company.create({ data: { name: unique("P2 A"), ownerId: alice.id } })).id;
    companyB = (await prisma.company.create({ data: { name: unique("P2 B"), ownerId: bob.id } })).id;
    agentA = (await createTestAgent({ companyId: companyA })).id;
    agentB = (await createTestAgent({ companyId: companyB })).id;
    planB = (await prisma.plan.create({ data: { title: "B plan", objective: "secret", companyId: companyB } })).id;
    approvalB = (
      await prisma.approvalRequest.create({
        data: { requesterType: "AGENT", requesterAgentId: agentB, action: "wallet.transfer", actionPayload: "{}", reason: "b", companyId: companyB },
      })
    ).id;
    conversationB = (await prisma.conversation.create({ data: { kind: "DIRECT", title: "B chat", companyId: companyB } })).id;
    factoryB = (await prisma.factoryRun.create({ data: { repoUrl: "https://github.com/b/b", companyId: companyB } })).id;
    await prisma.eventLog.create({
      data: { type: "test.b", actorType: "AGENT", actorId: agentB, correlationId: unique("corr"), payload: "{}" },
    });
  });

  const get = (path: string) => request(app).get(path).set("Authorization", alice.auth);

  it("hides another company's agents, plans, approvals, conversations and factory runs", async () => {
    for (const path of [
      `/api/v1/agents/${agentB}`,
      `/api/v1/agents/${agentB}/state`,
      `/api/v1/plans/${planB}`,
      `/api/v1/approvals/${approvalB}`,
      `/api/v1/conversations/${conversationB}`,
      `/api/v1/factory/runs/${factoryB}`,
      `/api/v1/performance/agents/${agentB}`,
      `/api/v1/performance/companies/${companyB}`,
      `/api/v1/relationships/agents/${agentB}`,
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect((await get(`/api/v1/agents/${agentA}`)).status).toBe(200);

    const agents = JSON.stringify((await get("/api/v1/agents")).body.data);
    expect(agents).toContain(agentA);
    expect(agents).not.toContain(agentB);
    expect(JSON.stringify((await get("/api/v1/plans")).body.data)).not.toContain(planB);
    expect(JSON.stringify((await get("/api/v1/approvals")).body.data)).not.toContain(approvalB);
    expect(JSON.stringify((await get("/api/v1/conversations")).body.data)).not.toContain(conversationB);
    expect(JSON.stringify((await get("/api/v1/factory/runs")).body.data)).not.toContain(factoryB);
  });

  it("refuses another company's ids in a body or query string", async () => {
    expect((await get(`/api/v1/memories?agentId=${agentB}`)).status).toBe(404);
    const assign = await request(app)
      .post("/api/v1/tasks")
      .set("Authorization", alice.auth)
      .send({ title: "steal B's agent", assigneeAgentId: agentB });
    expect(assign.status).toBe(404);
    const member = await request(app)
      .post(`/api/v1/companies/${companyA}/members`)
      .set("Authorization", alice.auth)
      .send({ agentId: agentB, roleKey: "EXECUTOR", title: "poached" });
    expect(member.status).toBe(404);
  });

  it("filters events by their actor and target", async () => {
    const principal = buildPrincipal({ id: alice.id, email: alice.email, displayName: "ADMIN", role: "ADMIN" });
    const scope = await companyScope(prisma, principal);
    const rows = [
      { companyId: null, actorType: "AGENT", actorId: agentB, targetType: null, targetId: null },
      { companyId: null, actorType: "SYSTEM", actorId: null, targetType: "Agent", targetId: agentB },
      { companyId: null, actorType: "AGENT", actorId: agentA, targetType: null, targetId: null },
      { companyId: null, actorType: "SYSTEM", actorId: null, targetType: null, targetId: null },
    ];
    const visible = await scopedLogs(scope, rows);
    expect(visible).toEqual([rows[2], rows[3]]);
    const http = await get("/api/v1/logs/events?type=test.b");
    expect(http.body.data).toEqual([]);
  });

  it("stops API keys whose owner is no longer a platform owner", async () => {
    const owner = await makeUser("OWNER");
    const perms = new Set(["agent.read"]);
    const { secret } = await createApiKey(
      prisma,
      { name: unique("k"), scopes: ["agent.read"], userId: owner.id, ownerPermissions: perms },
      { actor: SYSTEM },
    );
    expect(await authenticateApiKey(prisma, secret)).not.toBeNull();
    await prisma.user.update({ where: { id: owner.id }, data: { role: "ADMIN" } });
    expect(await authenticateApiKey(prisma, secret)).toBeNull();
  });
});
