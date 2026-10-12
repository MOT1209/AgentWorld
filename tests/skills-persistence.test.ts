/**
 * Durable skill state: catalog, assignments, usage counters and agent skill
 * requests live in the database (apps/api skill-store), not process memory.
 *
 * "Restart" is simulated with a brand-new PrismaClient + SkillStore on the
 * same database file: nothing is shared with the instance that wrote.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../apps/api/src/app.js";
import { SkillStore, skillStore } from "../apps/api/src/services/skill-store.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import {
  blankRecord,
  buildInstallationRecord,
  planInstallation,
  type SkillCatalogRecord,
} from "../packages/skills/src/index.js";
import { createTestAgent, unique } from "./helpers.js";

const app = createApp();
const restarted: PrismaClient[] = [];

/** A second store on the SAME database, sharing nothing with the first. */
function freshStore(): SkillStore {
  const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  restarted.push(client);
  return new SkillStore(client);
}

afterAll(async () => {
  await Promise.all(restarted.map((client) => client.$disconnect()));
});

function manifest(key: string, version = "1.0.0", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    name: `Skill ${key}`,
    description: "A harmless test skill.",
    version,
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
    ...extra,
  };
}

function installedRecord(key: string, overrides: Partial<SkillCatalogRecord> = {}): SkillCatalogRecord {
  const source = { type: "LOCAL" as const, identifier: key };
  const plan = planInstallation({ source, externalId: key, rawManifest: manifest(key), files: {} });
  return { ...buildInstallationRecord(undefined, source, key, plan, { enable: true }), ...overrides };
}

async function ownerToken(): Promise<string> {
  const email = `${unique("skills-owner")}@test.local`.toLowerCase();
  await prisma.user.create({
    data: { email, passwordHash: hashPassword("TestPassword123", 10), displayName: "Skills Owner", role: "OWNER", isActive: true },
  });
  const login = await request(app).post("/api/v1/auth/login").send({ email, password: "TestPassword123" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

describe("skill store persistence", () => {
  it("reads a saved skill back after a restart, and persists updates", async () => {
    const key = unique("persist").toLowerCase();
    await skillStore.save(installedRecord(key));

    const afterRestart = freshStore();
    const loaded = await afterRestart.get(key);
    expect(loaded?.key).toBe(key);
    expect(loaded?.installed).toBe(true);
    expect(loaded?.manifest?.version).toBe("1.0.0");

    await afterRestart.save({ ...(loaded as SkillCatalogRecord), enabled: false, status: "DISABLED" });
    const again = await freshStore().get(key);
    expect(again?.status).toBe("DISABLED");
    expect(again?.enabled).toBe(false);
    // One row per key: saving twice never duplicates.
    expect(await prisma.skillCatalogEntry.count({ where: { key } })).toBe(1);
  });

  it("keeps assignments across restarts and never duplicates them, even concurrently", async () => {
    const key = unique("assign").toLowerCase();
    await skillStore.save(installedRecord(key));
    const agent = await createTestAgent();

    const results = await Promise.all(Array.from({ length: 8 }, () => skillStore.assign(key, agent.id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await freshStore().agentsForSkill(key)).toEqual([agent.id]);
    expect(await skillStore.assign(key, agent.id)).toBe(false);
  });

  it("counts usage exactly under concurrency and keeps it after a restart", async () => {
    const key = unique("usage").toLowerCase();
    const agent = await createTestAgent();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        skillStore.recordUsage(key, { kind: "execution", success: i % 2 === 0, durationMs: 10, agentId: agent.id }),
      ),
    );
    await skillStore.recordUsage(key, { kind: "installation" });

    const counters = await freshStore().usage(key);
    expect(counters.executions).toBe(10);
    expect(counters.success).toBe(5);
    expect(counters.failure).toBe(5);
    expect(counters.totalDurationMs).toBe(100);
    expect(counters.installations).toBe(1);
    expect(counters.agents).toEqual([agent.id]);
  });

  it("removing a skill drops its assignments but keeps usage history", async () => {
    const key = unique("remove").toLowerCase();
    await skillStore.save(installedRecord(key));
    const agent = await createTestAgent();
    await skillStore.assign(key, agent.id);
    await skillStore.recordUsage(key, { kind: "installation" });

    expect(await skillStore.remove(key)).toBe(true);
    expect(await skillStore.remove(key)).toBe(false);
    expect(await skillStore.get(key)).toBeUndefined();
    expect(await prisma.skillAssignment.count({ where: { skillKey: key } })).toBe(0);
    expect((await skillStore.usage(key)).installations).toBe(1);
  });

  it("fails loudly on a corrupt row instead of overwriting it, and list skips it", async () => {
    const key = unique("corrupt").toLowerCase();
    await prisma.skillCatalogEntry.create({ data: { key, record: "{not json", status: "INSTALLED", installed: true } });
    await expect(skillStore.get(key)).rejects.toThrow(/unreadable/);
    expect((await skillStore.list()).some((r) => r.key === key)).toBe(false);
    const row = await prisma.skillCatalogEntry.findUniqueOrThrow({ where: { key } });
    expect(row.record).toBe("{not json");
  });

  it("rejects invalid records before writing anything", async () => {
    const tooLong = "k".repeat(200);
    await expect(skillStore.save(installedRecord("valid-key", { key: tooLong }))).rejects.toThrow(/Invalid skill key/);
    await expect(
      skillStore.save(installedRecord(unique("badstatus").toLowerCase(), { status: "HACKED" as never })),
    ).rejects.toThrow(/Invalid skill status/);
    expect(await prisma.skillCatalogEntry.count({ where: { key: tooLong } })).toBe(0);
  });

  it("rolls back the record when the paired usage write fails (no half-applied install)", async () => {
    const key = unique("atomic").toLowerCase();
    const store = new SkillStore(prisma);
    vi.spyOn(store, "recordUsage").mockRejectedValueOnce(new Error("disk full"));
    await expect(store.saveWithUsage(installedRecord(key), { kind: "installation" })).rejects.toThrow("disk full");
    expect(await skillStore.get(key)).toBeUndefined();
    expect((await skillStore.usage(key)).installations).toBe(0);
  });

  it("propagates storage failures instead of reporting success", async () => {
    const broken = new SkillStore({
      skillCatalogEntry: { upsert: () => Promise.reject(new Error("SQLITE_IOERR")) },
    } as unknown as PrismaClient);
    await expect(broken.save(installedRecord(unique("broken").toLowerCase()))).rejects.toThrow("SQLITE_IOERR");
  });

  it("persists skill requests and lets exactly one concurrent decision win", async () => {
    const created = await skillStore.createRequest({ skillKey: "planning", agentId: "agent-x", reason: "need it" });
    const loaded = await freshStore().getRequest(created.id);
    expect(loaded?.status).toBe("PENDING");

    const decisions = await Promise.all([
      skillStore.saveDecision({ ...created, status: "APPROVED", decidedByUserId: "u1" }),
      skillStore.saveDecision({ ...created, status: "REJECTED", decidedByUserId: "u2" }),
    ]);
    expect(decisions.filter(Boolean)).toHaveLength(1);
    expect((await freshStore().getRequest(created.id))?.status).not.toBe("PENDING");
  });
});

describe("skills API on the durable store", () => {
  it("install -> restart -> read, assign idempotently without faking executions", async () => {
    const token = await ownerToken();
    const auth = { Authorization: `Bearer ${token}` };
    const key = unique("api").toLowerCase();

    const installed = await request(app)
      .post("/api/v1/skills/external/install")
      .set(auth)
      .send({ source: { type: "LOCAL", identifier: key }, externalId: key, manifest: manifest(key), enable: true });
    expect(installed.status).toBe(201);

    // A restarted process reads the same catalog row.
    expect((await freshStore().get(key))?.status).toBe("ENABLED");

    const detail = await request(app).get(`/api/v1/skills/${key}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.usage.installations).toBe(1);

    const agent = await createTestAgent();
    const first = await request(app).post(`/api/v1/skills/${key}/assign`).set(auth).send({ agentId: agent.id });
    const second = await request(app).post(`/api/v1/skills/${key}/assign`).set(auth).send({ agentId: agent.id });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyAssigned).toBe(true);
    expect(second.body.data.agents).toEqual([agent.id]);
    const assignedEvents = await prisma.eventLog.count({ where: { type: "SKILL_ASSIGNED", targetId: key } });
    expect(assignedEvents).toBe(1);

    const usage = await request(app).get(`/api/v1/skills/${key}/usage`).set(auth);
    expect(usage.body.data.counters.executions).toBe(0);
    expect(usage.body.data.agents).toEqual([agent.id]);

    const removed = await request(app).delete(`/api/v1/skills/${key}`).set(auth);
    expect(removed.status).toBe(200);
    expect(await prisma.skillAssignment.count({ where: { skillKey: key } })).toBe(0);
  });

  it("binds a skill approval to its exact target and lets it be used once", async () => {
    const token = await ownerToken();
    const auth = { Authorization: `Bearer ${token}` };
    const key = unique("risky").toLowerCase();
    await skillStore.save(installedRecord(key, { risk: "HIGH" }));
    const agent = await createTestAgent();
    const other = await createTestAgent();

    const fileAndApprove = async (agentId: string): Promise<string> => {
      const held = await request(app).post(`/api/v1/skills/${key}/assign`).set(auth).send({ agentId });
      expect(held.status).toBe(202);
      const approvalId = held.body.data.approvalRequestId as string;
      const decided = await request(app)
        .post(`/api/v1/approvals/${approvalId}/decision`)
        .set(auth)
        .send({ decision: "APPROVED", replay: false });
      expect(decided.status).toBe(200);
      return approvalId;
    };

    // An approval granted for another agent must not unlock this assignment.
    const foreign = await fileAndApprove(other.id);
    const refused = await request(app)
      .post(`/api/v1/skills/${key}/assign`)
      .set(auth)
      .send({ agentId: agent.id, approvalRequestId: foreign });
    expect(refused.status).toBe(202);
    expect(await skillStore.agentsForSkill(key)).toEqual([]);

    const matching = await fileAndApprove(agent.id);
    const ok = await request(app)
      .post(`/api/v1/skills/${key}/assign`)
      .set(auth)
      .send({ agentId: agent.id, approvalRequestId: matching });
    expect(ok.status).toBe(200);
    expect(await skillStore.agentsForSkill(key)).toEqual([agent.id]);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: matching } })).executedAt).not.toBeNull();

    // Single use: the same approval cannot be replayed.
    await prisma.skillAssignment.deleteMany({ where: { skillKey: key } });
    const replay = await request(app)
      .post(`/api/v1/skills/${key}/assign`)
      .set(auth)
      .send({ agentId: agent.id, approvalRequestId: matching });
    expect(replay.status).toBe(202);
    expect(await skillStore.agentsForSkill(key)).toEqual([]);
  });

  it("binds an install approval to the exact content that was reviewed", async () => {
    const token = await ownerToken();
    const auth = { Authorization: `Bearer ${token}` };
    const key = unique("reviewed").toLowerCase();
    const src = { type: "LOCAL", identifier: key };
    // Unrestricted network -> REQUIRES_RUNTIME -> human review required (not blocked).
    const reviewed = manifest(key, "1.0.0", { network: { access: true, domains: [] }, instructions: "Read the audit summary." });
    const swapped = { ...reviewed, instructions: "Something the reviewer never saw." };

    const held = await request(app).post("/api/v1/skills/external/install").set(auth)
      .send({ source: src, externalId: key, manifest: reviewed });
    expect(held.status).toBe(202);
    const approvalRequestId = held.body.data.approvalRequestId as string;
    await request(app).post(`/api/v1/approvals/${approvalRequestId}/decision`).set(auth)
      .send({ decision: "APPROVED", replay: false }).expect(200);

    const tampered = await request(app).post("/api/v1/skills/external/install").set(auth)
      .send({ source: src, externalId: key, manifest: swapped, approvalRequestId });
    expect(tampered.status).toBe(202);
    expect(await skillStore.get(key)).toBeUndefined();

    const installed = await request(app).post("/api/v1/skills/external/install").set(auth)
      .send({ source: src, externalId: key, manifest: reviewed, approvalRequestId });
    expect(installed.status).toBe(201);
    expect((await freshStore().get(key))?.manifest?.instructions).toBe("Read the audit summary.");
  });

  it("rolls back to the older version's real manifest", async () => {
    const token = await ownerToken();
    const auth = { Authorization: `Bearer ${token}` };
    const key = unique("rollback").toLowerCase();
    const src = { type: "LOCAL", identifier: key };
    await request(app).post("/api/v1/skills/external/install").set(auth)
      .send({ source: src, externalId: key, manifest: manifest(key, "1.0.0", { description: "version one" }) })
      .expect(201);
    await request(app).post(`/api/v1/skills/${key}/update`).set(auth)
      .send({ manifest: manifest(key, "1.1.0", { description: "version two" }) })
      .expect(200);

    const rolled = await request(app).post(`/api/v1/skills/${key}/rollback`).set(auth).send({});
    expect(rolled.status).toBe(200);
    const record = await freshStore().get(key);
    expect(record?.installedVersion).toBe("1.0.0");
    expect(record?.manifest?.version).toBe("1.0.0");
    expect(record?.manifest?.description).toBe("version one");
    expect((await skillStore.usage(key)).rollbacks).toBe(1);
  });

  it("persists agent skill requests and refuses a second decision", async () => {
    const token = await ownerToken();
    const auth = { Authorization: `Bearer ${token}` };
    const created = await request(app).post("/api/v1/skills/requests").set(auth)
      .send({ skillKey: "planning", agentId: "agent-1", reason: "planning work" });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await freshStore().getRequest(id))?.status).toBe("PENDING");

    const decided = await request(app).post(`/api/v1/skills/requests/${id}/decision`).set(auth).send({ decision: "APPROVED" });
    expect(decided.status).toBe(200);
    const again = await request(app).post(`/api/v1/skills/requests/${id}/decision`).set(auth).send({ decision: "REJECTED" });
    expect(again.status).toBe(409);
    expect((await freshStore().getRequest(id))?.status).toBe("APPROVED");
  });

  it("answers a security-blocked install with 403 and its reason, not a 500", async () => {
    const token = await ownerToken();
    const key = unique("blocked").toLowerCase();
    const blocked = await request(app).post("/api/v1/skills/external/install").set({ Authorization: `Bearer ${token}` })
      .send({ source: { type: "LOCAL", identifier: key }, externalId: key, manifest: manifest(key, "1.0.0", { permissions: ["audit.read"] }) });
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/blocked by security analysis/);
    expect(await skillStore.get(key)).toBeUndefined();
  });

  it("rejects invalid input without touching the store", async () => {
    const token = await ownerToken();
    const auth = { Authorization: `Bearer ${token}` };
    const before = await prisma.skillCatalogEntry.count();
    const bad = await request(app).post("/api/v1/skills/external/install").set(auth)
      .send({ source: { type: "LOCAL", identifier: "x" }, externalId: "", manifest: manifest("x") });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    expect(await prisma.skillCatalogEntry.count()).toBe(before);
  });
});

describe("blankRecord sanity", () => {
  it("is a valid DISCOVERED record the store accepts", async () => {
    const key = unique("blank").toLowerCase();
    await skillStore.save(blankRecord({ key, name: "Blank", description: "d", source: { type: "LOCAL", identifier: key }, externalId: key }));
    expect((await skillStore.get(key))?.status).toBe("DISCOVERED");
  });
});
