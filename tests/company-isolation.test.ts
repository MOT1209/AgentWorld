import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import { signAccessToken } from "../packages/security/src/tokens.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { unique } from "./helpers.js";

// F4: companies are visible only to the platform OWNER, the company's owner,
// and users granted through CompanyAccess. Invisible companies answer 404.

const app = createApp();

async function makeUser(role: "OWNER" | "ADMIN" | "OBSERVER"): Promise<{ id: string; email: string; auth: string }> {
  const email = `${unique(role.toLowerCase())}@iso.test`.toLowerCase();
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword("TestPassword123", 10), displayName: role, role, isActive: true },
  });
  const token = signAccessToken({ userId: user.id, email, displayName: role, role });
  return { id: user.id, email, auth: `Bearer ${token}` };
}

describe("company isolation", () => {
  let platformOwner: Awaited<ReturnType<typeof makeUser>>;
  let alice: Awaited<ReturnType<typeof makeUser>>; // ADMIN, owns company A
  let bob: Awaited<ReturnType<typeof makeUser>>; // ADMIN, owns company B
  let watcher: Awaited<ReturnType<typeof makeUser>>; // OBSERVER, no grants yet
  let companyA: string;
  let companyB: string;
  let taskB: string;

  beforeAll(async () => {
    platformOwner = await makeUser("OWNER");
    alice = await makeUser("ADMIN");
    bob = await makeUser("ADMIN");
    watcher = await makeUser("OBSERVER");
    const a = await request(app).post("/api/v1/companies").set("Authorization", alice.auth).send({ name: unique("Iso A") });
    const b = await request(app).post("/api/v1/companies").set("Authorization", bob.auth).send({ name: unique("Iso B") });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    companyA = a.body.data.id as string;
    companyB = b.body.data.id as string;
    const task = await prisma.task.create({ data: { title: unique("secret B task"), companyId: companyB } });
    taskB = task.id;
    await ensureWallet(prisma, { ownerType: "COMPANY", ownerId: companyB });
  });

  it("lists only visible companies; the platform owner sees all", async () => {
    const asAlice = await request(app).get("/api/v1/companies").set("Authorization", alice.auth);
    const ids = (asAlice.body.data as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(companyA);
    expect(ids).not.toContain(companyB);

    const asOwner = await request(app).get("/api/v1/companies").set("Authorization", platformOwner.auth);
    const ownerIds = (asOwner.body.data as Array<{ id: string }>).map((c) => c.id);
    expect(ownerIds).toEqual(expect.arrayContaining([companyA, companyB]));
  });

  it("answers 404 for another company's routes, treasury, task and wallet", async () => {
    for (const path of [
      `/api/v1/companies/${companyB}`,
      `/api/v1/companies/${companyB}/overview`,
      `/api/v1/companies/${companyB}/members`,
      `/api/v1/economy/treasury/${companyB}`,
      `/api/v1/tasks/${taskB}`,
    ]) {
      const res = await request(app).get(path).set("Authorization", alice.auth);
      expect(res.status, path).toBe(404);
    }
    const wallet = await prisma.wallet.findFirstOrThrow({ where: { ownerType: "COMPANY", ownerId: companyB } });
    expect((await request(app).get(`/api/v1/economy/wallets/${wallet.id}`).set("Authorization", alice.auth)).status).toBe(404);

    const wallets = await request(app).get("/api/v1/economy/wallets").set("Authorization", alice.auth);
    const walletIds = (wallets.body.data as Array<{ wallet: { id: string } }>).map((row) => row.wallet.id);
    expect(walletIds).not.toContain(wallet.id);

    const tasks = await request(app).get("/api/v1/tasks?pageSize=200").set("Authorization", alice.auth);
    expect(JSON.stringify(tasks.body.data)).not.toContain(taskB);

    const created = await request(app)
      .post("/api/v1/tasks")
      .set("Authorization", alice.auth)
      .send({ title: "smuggle into B", companyId: companyB });
    expect(created.status).toBe(404);
  });

  it("keeps platform-wide ledger figures owner-only", async () => {
    expect((await request(app).get("/api/v1/economy/totals").set("Authorization", alice.auth)).status).toBe(403);
    expect((await request(app).get("/api/v1/economy/totals").set("Authorization", platformOwner.auth)).status).toBe(200);
  });

  it("lets the company owner grant and revoke visibility; others cannot", async () => {
    expect((await request(app).get(`/api/v1/companies/${companyB}`).set("Authorization", watcher.auth)).status).toBe(404);

    // Alice can see A but does not own B: B stays a 404 for her, even for grants.
    const denied = await request(app)
      .post(`/api/v1/companies/${companyB}/access`)
      .set("Authorization", alice.auth)
      .send({ email: watcher.email });
    expect(denied.status).toBe(404);

    const granted = await request(app)
      .post(`/api/v1/companies/${companyB}/access`)
      .set("Authorization", bob.auth)
      .send({ email: watcher.email });
    expect(granted.status).toBe(201);
    expect((await request(app).get(`/api/v1/companies/${companyB}`).set("Authorization", watcher.auth)).status).toBe(200);

    // A granted observer still cannot manage access.
    const notOwner = await request(app)
      .post(`/api/v1/companies/${companyB}/access`)
      .set("Authorization", watcher.auth)
      .send({ email: alice.email });
    expect(notOwner.status).toBe(403);

    const revoked = await request(app).delete(`/api/v1/companies/${companyB}/access/${watcher.id}`).set("Authorization", bob.auth);
    expect(revoked.status).toBe(204);
    expect((await request(app).get(`/api/v1/companies/${companyB}`).set("Authorization", watcher.auth)).status).toBe(404);
  });
});

describe("task pagination totals", () => {
  it("counts with the same filters the page uses", async () => {
    const { listTasks, countTasks } = await import("../packages/tasks/src/task.service.js");
    const marker = unique("needle");
    await prisma.task.create({ data: { title: `${marker} one` } });
    await prisma.task.create({ data: { title: `${marker} two`, priority: "HIGH" } });
    for (const query of [{ search: marker }, { search: marker, priority: "HIGH" }]) {
      const items = await listTasks(prisma, { ...query, take: 200 });
      expect(await countTasks(prisma, query), JSON.stringify(query)).toBe(items.length);
    }
  });
});
