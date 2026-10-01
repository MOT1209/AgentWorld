import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import { getSimulationEngine, setSimulationEngine } from "../packages/simulation/src/index.js";
import { unique } from "./helpers.js";

const app = createApp();

// The engine is process-wide; stop its heartbeat so it cannot tick a RUNNING
// world behind later test files.
afterAll(() => {
  getSimulationEngine().dispose();
  setSimulationEngine(null);
});

async function ownerToken(): Promise<string> {
  const email = `${unique("sim-owner")}@test.local`.toLowerCase();
  await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword("TestPassword123", 10),
      displayName: "Sim Owner",
      role: "OWNER",
      isActive: true,
    },
  });
  const login = await request(app).post("/api/v1/auth/login").send({ email, password: "TestPassword123" });
  return login.body.token as string;
}

describe("simulation api", () => {
  it("controls the world, ticks it, and serves agent simulation state", async () => {
    const token = await ownerToken();
    const auth = { Authorization: `Bearer ${token}` };

    const worldRes = await request(app)
      .post("/api/v1/world/worlds")
      .set(auth)
      .send({ name: unique("API World"), timeScale: 60 });
    expect(worldRes.status).toBe(201);
    const worldId = worldRes.body.data.id as string;
    expect(worldRes.body.data.status).toBe("INITIALIZING");

    const agentRes = await request(app)
      .post("/api/v1/agents")
      .set(auth)
      .send({
        name: unique("Sim Api Agent"),
        roleKey: "EXECUTOR",
        title: "Sim Tester",
        systemPrompt: "Test executor.",
        providerId: "mock",
        model: "mock-1",
        worldId,
      });
    expect(agentRes.status).toBe(201);
    const agentId = agentRes.body.data.id as string;

    // Agent comes up OFFLINE; bring it online before it may act.
    const online = await request(app)
      .post(`/api/v1/agents/${agentId}/state`)
      .set(auth)
      .send({ state: "IDLE" });
    expect(online.status).toBe(200);

    const started = await request(app)
      .post("/api/v1/simulation/start")
      .set(auth)
      .send({ worldId });
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe("RUNNING");
    expect(started.body.data.heartbeatRunning).toBe(true);

    const tick = await request(app)
      .post("/api/v1/simulation/tick")
      .set(auth)
      .send({ worldId });
    expect(tick.status).toBe(200);
    expect(tick.body.data.worldId).toBe(worldId);
    expect(typeof tick.body.data.agentsProcessed).toBe("number");

    const stateRes = await request(app).get(`/api/v1/simulation/state?worldId=${worldId}`).set(auth);
    expect(stateRes.status).toBe(200);
    expect(stateRes.body.data.world.id).toBe(worldId);
    expect(stateRes.body.data.counts.agents).toBe(1);
    expect(Array.isArray(stateRes.body.data.agents)).toBe(true);

    const needs = await request(app).get(`/api/v1/agents/${agentId}/needs`).set(auth);
    expect(needs.status).toBe(200);
    expect(needs.body.data.needs.ENERGY).toBeGreaterThan(0);

    const goal = await request(app)
      .post(`/api/v1/agents/${agentId}/goals`)
      .set(auth)
      .send({ title: unique("Goal"), priority: "HIGH", status: "ACTIVE" });
    expect(goal.status).toBe(201);

    const goals = await request(app).get(`/api/v1/agents/${agentId}/goals`).set(auth);
    expect(goals.status).toBe(200);
    expect(goals.body.data.length).toBe(1);

    const action = await request(app)
      .post(`/api/v1/agents/${agentId}/actions`)
      .set(auth)
      .send({ type: "IDLE", reason: "api test" });
    expect(action.status).toBe(200);
    expect(action.body.data.action).toBe("IDLE");

    const activity = await request(app).get(`/api/v1/agents/${agentId}/activity`).set(auth);
    expect(activity.status).toBe(200);
    expect(activity.body.data.open).toBeNull();

    const stopped = await request(app)
      .post("/api/v1/simulation/stop")
      .set(auth)
      .send({ worldId });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.status).toBe("STOPPED");
  });

  it("rejects a simulation action when the world is not running", async () => {
    const token = await ownerToken();
    const auth = { Authorization: `Bearer ${token}` };

    const worldRes = await request(app)
      .post("/api/v1/world/worlds")
      .set(auth)
      .send({ name: unique("Paused World"), timeScale: 60 });
    const worldId = worldRes.body.data.id as string;

    const agentRes = await request(app)
      .post("/api/v1/agents")
      .set(auth)
      .send({
        name: unique("Paused Agent"),
        roleKey: "EXECUTOR",
        title: "Paused",
        systemPrompt: "Test.",
        providerId: "mock",
        model: "mock-1",
        worldId,
      });
    const agentId = agentRes.body.data.id as string;
    await request(app).post(`/api/v1/agents/${agentId}/state`).set(auth).send({ state: "IDLE" });

    const action = await request(app)
      .post(`/api/v1/agents/${agentId}/actions`)
      .set(auth)
      .send({ type: "IDLE" });
    expect(action.status).toBe(400);
  });

  it("refuses the event stream without a token", async () => {
    const res = await request(app).get("/api/v1/events/stream");
    expect(res.status).toBe(401);
  });
});
