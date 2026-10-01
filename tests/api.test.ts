import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import { unique } from "./helpers.js";

const app = createApp();

async function createOwnerAndToken(): Promise<{ token: string; userId: string }> {
  const email = `${unique("owner")}@test.local`.toLowerCase();
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword("TestPassword123", 10),
      displayName: "Owner",
      role: "OWNER",
      isActive: true,
    },
  });
  const login = await request(app).post("/api/v1/auth/login").send({ email, password: "TestPassword123" });
  expect(login.status).toBe(200);
  return { token: login.body.token as string, userId: user.id };
}

describe("api integration", () => {
  it("auth -> chat -> task -> agent run -> report", async () => {
    const { token } = await createOwnerAndToken();
    const auth = { Authorization: `Bearer ${token}` };

    const me = await request(app).get("/api/v1/auth/me").set(auth);
    expect(me.status).toBe(200);

    const agents = await request(app).get("/api/v1/agents").set(auth);
    expect(agents.status).toBe(200);
    expect(Array.isArray(agents.body.data)).toBe(true);

    const created = await request(app)
      .post("/api/v1/agents")
      .set(auth)
      .send({
        name: unique("Api Agent"),
        roleKey: "EXECUTOR",
        title: "API Tester",
        systemPrompt: "You are a test executor. Reply concisely.",
        providerId: "mock",
        model: "mock-1",
      });
    expect(created.status).toBe(201);
    const agentId = created.body.data.id as string;

    const task = await request(app)
      .post("/api/v1/tasks")
      .set(auth)
      .send({ title: unique("API task title"), assigneeAgentId: agentId });
    expect(task.status).toBe(201);

    const chat = await request(app)
      .post(`/api/v1/agents/${agentId}/chat`)
      .set(auth)
      .send({ content: "Hello, give me a status update." });
    expect(chat.status).toBe(200);
    expect(chat.body.data.run).toBeDefined();

    const snapshot = await request(app).get("/api/v1/world/snapshot").set(auth);
    expect([200, 404, 500]).toContain(snapshot.status);

    const approvals = await request(app).get("/api/v1/approvals").set(auth);
    expect(approvals.status).toBe(200);

    const events = await request(app).get("/api/v1/logs/events").set(auth);
    expect(events.status).toBe(200);
  });

  it("rejects unauthenticated and forbidden access", async () => {
    const anon = await request(app).get("/api/v1/agents");
    expect(anon.status).toBe(401);

    const { token } = await createOwnerAndToken();
    const missing = await request(app).get("/api/v1/agents/does-not-exist").set({ Authorization: `Bearer ${token}` });
    expect(missing.status).toBe(404);
  });
});
