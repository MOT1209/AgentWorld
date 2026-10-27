import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { skillStore } from "../apps/api/src/services/skill-store.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import { signAccessToken } from "../packages/security/src/tokens.js";
import { buildPrincipal } from "../packages/security/src/rbac.js";
import { requireVisibleWallet, assertWalletOwnerVisible } from "../packages/security/src/company-access.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { OAUTH_PROVIDERS, beginAuthorization } from "../packages/connectors/src/index.js";
import { buildInstallationRecord, planInstallation } from "../packages/skills/src/index.js";
import { CORRELATION, SYSTEM, createTestAgent, unique } from "./helpers.js";

// Fourth pass (2026-10-26), REST side and configuration:
//   AW-28  POST /tasks and POST /tasks/:id/dependencies accepted another
//          company's task in dependsOn, and GET /tasks/:id then showed it
//   AW-30  economy routes acted on any wallet id; /wallets/ensure minted a
//          wallet for an owner that does not exist
//   AW-31  /skills/:key/usage listed every company's agents, and a company
//          admin could decide another company's agent's skill request
//   AW-32  the OAuth state key fell back to a public constant in production
// Each test below failed against the code as it stood before the fix.

const app = createApp();

async function makeUser(role: "OWNER" | "ADMIN"): Promise<{ id: string; auth: string; role: "OWNER" | "ADMIN"; email: string }> {
  const email = `${unique(role.toLowerCase())}@pass4.test`.toLowerCase();
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword("TestPassword123", 10), displayName: role, role, isActive: true },
  });
  const token = signAccessToken({ userId: user.id, email, displayName: role, role });
  return { id: user.id, auth: `Bearer ${token}`, role, email };
}

let platformOwner: Awaited<ReturnType<typeof makeUser>>;
let alice: Awaited<ReturnType<typeof makeUser>>; // ADMIN, owns company A
let bob: Awaited<ReturnType<typeof makeUser>>; // ADMIN, owns company B
let companyA: string;
let companyB: string;
let taskA: string;
let taskB: string;

beforeAll(async () => {
  platformOwner = await makeUser("OWNER");
  alice = await makeUser("ADMIN");
  bob = await makeUser("ADMIN");
  companyA = (await prisma.company.create({ data: { name: unique("Pass4 A"), ownerId: alice.id } })).id;
  companyB = (await prisma.company.create({ data: { name: unique("Pass4 B"), ownerId: bob.id } })).id;
  taskA = (await prisma.task.create({ data: { title: unique("A visible task"), companyId: companyA } })).id;
  taskB = (await prisma.task.create({ data: { title: unique("B-secret-task"), companyId: companyB } })).id;
});

describe("AW-28: REST task dependencies stay inside the task's company", () => {
  it("POST /tasks with a foreign dependsOn is a 404 and creates nothing", async () => {
    const title = unique("needs a secret");
    const res = await request(app)
      .post("/api/v1/tasks")
      .set("Authorization", alice.auth)
      .send({ title, companyId: companyA, dependsOn: [taskB] });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("B-secret-task");
    expect(await prisma.taskDependency.count({ where: { dependsOnTaskId: taskB } })).toBe(0);
    expect(await prisma.task.count({ where: { title } }), "a refused task must not be left behind").toBe(0);
  });

  it("POST /tasks/:id/dependencies with a foreign task is a 404 and links nothing", async () => {
    const res = await request(app)
      .post(`/api/v1/tasks/${taskA}/dependencies`)
      .set("Authorization", alice.auth)
      .send({ dependsOn: [taskB] });
    expect(res.status).toBe(404);
    expect(await prisma.taskDependency.count({ where: { taskId: taskA, dependsOnTaskId: taskB } })).toBe(0);
    const detail = await request(app).get(`/api/v1/tasks/${taskA}`).set("Authorization", alice.auth);
    expect(JSON.stringify(detail.body)).not.toContain("B-secret-task");
  });

  it("a shared-world task cannot depend on a company task either", async () => {
    const shared = await prisma.task.create({ data: { title: unique("shared") } });
    const res = await request(app)
      .post(`/api/v1/tasks/${shared.id}/dependencies`)
      .set("Authorization", platformOwner.auth)
      .send({ dependsOn: [taskB] });
    expect(res.status).toBe(404);
  });

  it("same-company and shared dependencies still work (control)", async () => {
    const shared = await prisma.task.create({ data: { title: unique("shared prerequisite") } });
    const res = await request(app)
      .post("/api/v1/tasks")
      .set("Authorization", alice.auth)
      .send({ title: unique("follow-up"), companyId: companyA, dependsOn: [taskA, shared.id] });
    expect(res.status).toBe(201);
  });
});

describe("AW-30: wallet routes act only on wallets the caller can see", () => {
  it("requireVisibleWallet hides another company's wallet behind a 404", async () => {
    const walletA = await ensureWallet(prisma, { ownerType: "COMPANY", ownerId: companyA });
    const walletB = await ensureWallet(prisma, { ownerType: "COMPANY", ownerId: companyB });
    const principal = buildPrincipal({ id: alice.id, email: alice.email, displayName: "A", role: "ADMIN" });
    const scope = { all: false as const, companyIds: new Set([companyA]) };
    await expect(requireVisibleWallet(prisma, principal, scope, walletB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await requireVisibleWallet(prisma, principal, scope, walletA.id)).id).toBe(walletA.id);
    await expect(
      assertWalletOwnerVisible(prisma, principal, scope, { ownerType: "COMPANY", ownerId: companyB }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("/wallets/ensure refuses an owner that does not exist and mints nothing", async () => {
    const phantom = `cx${unique("phantom").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(22, "0")}`;
    const res = await request(app)
      .post("/api/v1/economy/wallets/ensure")
      .set("Authorization", platformOwner.auth)
      .send({ ownerType: "AGENT", ownerId: phantom });
    expect(res.status).toBe(404);
    expect(await prisma.wallet.count({ where: { ownerId: phantom } })).toBe(0);
  });

  it("/wallets/ensure still works for a real owner (control)", async () => {
    const agent = await createTestAgent({ roleKey: "EXECUTOR", companyId: companyA });
    const res = await request(app)
      .post("/api/v1/economy/wallets/ensure")
      .set("Authorization", platformOwner.auth)
      .send({ ownerType: "AGENT", ownerId: agent.id });
    expect(res.status).toBe(201);
  });
});

function installedRecord(key: string) {
  const source = { type: "LOCAL" as const, identifier: key };
  const plan = planInstallation({
    source,
    externalId: key,
    rawManifest: {
      key,
      name: `Skill ${key}`,
      description: "A harmless test skill.",
      version: "1.0.0",
      author: "Tests",
      category: "testing",
      capabilities: [],
      permissions: [],
      tools: [],
      dependencies: [],
      secretRequirements: [],
      network: { access: false, domains: [] },
      instructions: "List the workspace files.",
      files: [],
    },
    files: {},
  });
  return buildInstallationRecord(undefined, source, key, plan, { enable: true });
}

describe("AW-31: skill usage and skill requests respect company scope", () => {
  it("/skills/:key/usage lists only agents the caller can see", async () => {
    const key = unique("pass4-usage").toLowerCase();
    await skillStore.save(installedRecord(key));
    const agentA = await createTestAgent({ roleKey: "EXECUTOR", companyId: companyA });
    const agentB = await createTestAgent({ roleKey: "EXECUTOR", companyId: companyB });
    await skillStore.assign(key, agentA.id);
    await skillStore.assign(key, agentB.id);
    await skillStore.recordUsage(key, { kind: "execution", success: true, durationMs: 5, agentId: agentB.id });

    const res = await request(app).get(`/api/v1/skills/${key}/usage`).set("Authorization", alice.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.agents).toContain(agentA.id);
    expect(JSON.stringify(res.body)).not.toContain(agentB.id);

    const asOwner = await request(app).get(`/api/v1/skills/${key}/usage`).set("Authorization", platformOwner.auth);
    expect(asOwner.body.data.agents).toEqual(expect.arrayContaining([agentA.id, agentB.id]));
  });

  it("a company admin cannot decide another company's agent's skill request", async () => {
    const agentB = await createTestAgent({ roleKey: "EXECUTOR", companyId: companyB });
    const { id } = await skillStore.createRequest({ skillKey: "some-skill", agentId: agentB.id, reason: "needed for B work" });
    const res = await request(app)
      .post(`/api/v1/skills/requests/${id}/decision`)
      .set("Authorization", alice.auth)
      .send({ decision: "APPROVED" });
    expect(res.status).toBe(404);
    expect((await skillStore.getRequest(id))?.status).toBe("PENDING");

    const byBob = await request(app)
      .post(`/api/v1/skills/requests/${id}/decision`)
      .set("Authorization", bob.auth)
      .send({ decision: "REJECTED" });
    expect(byBob.status).toBe(200);
  });
});

describe("AW-32: OAuth state signing needs a real key in production", () => {
  const PRODUCTION_ENV: Record<string, string> = {
    NODE_ENV: "production",
    JWT_SECRET: "j".repeat(48),
    SEED_OWNER_PASSWORD: "Not-The-Default-Seed-1",
    EXEC_SANDBOX: "docker",
    VAULT_MASTER_KEY: "",
  };
  const SLUG = "pass4-oauth";

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

  it("refuses to sign a state with the public development key", async () => {
    OAUTH_PROVIDERS.set(SLUG, {
      connectorSlug: SLUG,
      authorizeUrl: "https://provider.example/authorize",
      tokenUrl: "https://provider.example/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      scopes: ["read"],
    });
    try {
      await withEnv(PRODUCTION_ENV, async () => {
        await expect(beginAuthorization(SLUG, { actor: SYSTEM, db: prisma, correlationId: CORRELATION })).rejects.toThrow(
          /VAULT_MASTER_KEY/,
        );
      });
      // Development keeps working without a key (control).
      const begun = await beginAuthorization(SLUG, { actor: SYSTEM, db: prisma, correlationId: CORRELATION });
      expect(begun.state).toContain(".");
    } finally {
      OAUTH_PROVIDERS.delete(SLUG);
    }
  });
});
