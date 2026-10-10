/**
 * Read-only daily-routine schedule endpoint (Step 4 follow-through).
 *
 * GET /api/v1/agents/:id/routines surfaces the Phase 5 routine rows the 3D
 * inspector displays. No writes, no schema change, AGENT_READ gated.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { createAgentRoutine } from "../packages/simulation/src/index.js";
import { SYSTEM, CORRELATION, createTestAgent, createTestUser, unique } from "./helpers.js";

const app = createApp();

async function ownerHeaders(): Promise<Record<string, string>> {
  const email = `${unique("routine-owner")}@test.local`.toLowerCase();
  await createTestUser(email);
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: "TestPassword123" });
  return { Authorization: `Bearer ${login.body.token as string}` };
}

describe("agent routines api", () => {
  it("serves an agent's active routines earliest-slot-first", async () => {
    const auth = await ownerHeaders();
    const world = await prisma.world.create({
      data: { name: unique("Routine API World"), timeScale: 60, status: "RUNNING", timeOffsetMinutes: 0 },
    });
    const city = await prisma.city.create({
      data: { worldId: world.id, name: unique("Routine API City"), kind: "CAPITAL" },
    });
    const office = await prisma.location.create({
      data: { cityId: city.id, name: unique("Routine API Office"), kind: "OFFICE" },
    });
    const agent = await createTestAgent({ worldId: world.id });

    await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 540, activityType: "WORK", locationId: office.id, durationSimMinutes: 240 },
      { actor: SYSTEM, correlationId: CORRELATION, worldId: world.id },
    );
    await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 420, activityType: "REST", durationSimMinutes: 30 },
      { actor: SYSTEM, correlationId: CORRELATION, worldId: world.id },
    );
    const inactive = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 1200, activityType: "SLEEP", durationSimMinutes: 300 },
      { actor: SYSTEM, correlationId: CORRELATION, worldId: world.id },
    );
    await prisma.agentRoutine.update({ where: { id: inactive.id }, data: { active: false } });

    const res = await request(app).get(`/api/v1/agents/${agent.id}/routines`).set(auth);
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ slotMinutes: number; activityType: string; locationId: string | null }>;
    expect(rows.map((r) => r.slotMinutes)).toEqual([420, 540]);
    expect(rows[1]?.locationId).toBe(office.id);

    const withInactive = await request(app)
      .get(`/api/v1/agents/${agent.id}/routines?includeInactive=true`)
      .set(auth);
    expect(withInactive.status).toBe(200);
    expect((withInactive.body.data as unknown[]).length).toBe(3);
  });

  it("returns an empty list for unknown agents and requires auth", async () => {
    const auth = await ownerHeaders();
    const missing = await request(app).get("/api/v1/agents/no-such-agent/routines").set(auth);
    expect(missing.status).toBe(200);
    expect(missing.body.data).toEqual([]);

    const anon = await request(app).get("/api/v1/agents/no-such-agent/routines");
    expect(anon.status).toBe(401);
  });
});
