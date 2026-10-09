/**
 * Phase 5: daily routine engine.
 *
 * A routine is a scheduled activity attached to an agent (a slot of the
 * simulated day, an activity type, an optional location, a duration). The
 * engine evaluates routines on the existing tick: a due routine fires when the
 * agent is free and at the right place, otherwise the miss is surfaced as a
 * ROUTINE_SKIPPED event -- never a crash.
 */
import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import {
  completeActivity,
  createAgentRoutine,
  deleteAgentRoutine,
  evaluateAgentRoutines,
  listAgentRoutines,
  SimulationEngine,
  startActivity,
  updateAgentRoutine,
  getOpenActivity,
} from "../packages/simulation/src/index.js";
import { changeAgentState, getAgentState } from "../packages/agents/src/index.js";
import { moveAgent } from "../packages/world/src/index.js";
import { eventBus, EVENT_TYPES } from "../packages/events/src/index.js";
import { listActivity } from "../packages/events/src/audit.js";
import { SYSTEM, CORRELATION, createTestAgent, unique } from "./helpers.js";

const CTX = { actor: SYSTEM, correlationId: CORRELATION };

/** Deterministic wall-clock anchors: 09:00 and 10:00 UTC on a fixed day. */
const BASE = new Date(Date.UTC(2026, 2, 16, 9, 0, 0));
const TEN = new Date(Date.UTC(2026, 2, 16, 10, 0, 0));

function simDateKey(of: Date): string {
  const month = String(of.getUTCMonth() + 1).padStart(2, "0");
  const day = String(of.getUTCDate()).padStart(2, "0");
  return `${of.getUTCFullYear()}-${month}-${day}`;
}

async function makeWorld(): Promise<{ worldId: string; officeId: string; commonId: string }> {
  const world = await prisma.world.create({
    data: {
      name: unique("Routine World"),
      timeScale: 61,
      status: "RUNNING",
      timeOffsetMinutes: 0,
      lastTickAt: new Date(BASE.getTime() - 60_000),
    },
  });
  const city = await prisma.city.create({
    data: { worldId: world.id, name: unique("Routine City"), kind: "CAPITAL" },
  });
  const office = await prisma.location.create({
    data: { cityId: city.id, name: unique("Office"), kind: "OFFICE" },
  });
  const common = await prisma.location.create({
    data: { cityId: city.id, name: unique("Common"), kind: "PUBLIC_SPACE" },
  });
  return { worldId: world.id, officeId: office.id, commonId: common.id };
}

describe("phase5 routine CRUD", () => {
  it("creates, lists and deletes routines with events and audit rows", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });

    let seen = 0;
    const off = eventBus.subscribe(EVENT_TYPES.ROUTINE_CREATED, (event) => {
      seen += 1;
      expect(event.payload).toMatchObject({ agentId: agent.id, activityType: "WORK" });
    });

    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 510, activityType: "WORK", durationSimMinutes: 60 },
      { ...CTX, worldId },
    );
    off();
    expect(seen).toBe(1);
    expect(routine.slotMinutes).toBe(510);
    expect(routine.durationSimMinutes).toBe(60);
    expect(routine.active).toBe(true);

    const morning = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 420, activityType: "REST", durationSimMinutes: 30 },
      { ...CTX, worldId },
    );
    expect(morning.id).not.toBe(routine.id);

    const routines = await listAgentRoutines(prisma, { agentId: agent.id });
    expect(routines.map((r) => r.slotMinutes)).toEqual([420, 510]);

    const audit = await listActivity(prisma, { action: "routine.create", take: 10 });
    expect(audit.filter((row) => row.targetType === "AgentRoutine").length).toBeGreaterThanOrEqual(2);

    await deleteAgentRoutine(prisma, routine.id, { ...CTX, worldId });
    const after = await listAgentRoutines(prisma, { agentId: agent.id });
    expect(after.find((r) => r.id === routine.id)).toBeUndefined();
    expect(after.find((r) => r.id === morning.id)).toBeDefined();

    const deletedAudit = await listActivity(prisma, { action: "routine.delete", take: 5 });
    expect(deletedAudit.some((row) => row.targetId === routine.id)).toBe(true);
  });

  it("rejects duplicate (agent, slot, type), invalid inputs and foreign locations", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });
    const otherWorld = await prisma.world.create({
      data: { name: unique("Other Routine World"), timeScale: 1, status: "RUNNING", timeOffsetMinutes: 0 },
    });
    const otherCity = await prisma.city.create({
      data: { worldId: otherWorld.id, name: unique("Other City"), kind: "CAPITAL" },
    });
    const foreign = await prisma.location.create({
      data: { cityId: otherCity.id, name: unique("Foreign"), kind: "SHOP" },
    });

    await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 480, activityType: "WORK", durationSimMinutes: 60 },
      { ...CTX, worldId },
    );

    await expect(
      createAgentRoutine(
        prisma,
        { agentId: agent.id, slotMinutes: 480, activityType: "WORK", durationSimMinutes: 60 },
        { ...CTX, worldId },
      ),
    ).rejects.toThrow(/already exists/i);

    await expect(
      createAgentRoutine(
        prisma,
        { agentId: agent.id, slotMinutes: 1440, activityType: "WORK", durationSimMinutes: 60 },
        { ...CTX, worldId },
      ),
    ).rejects.toThrow(/slot/i);
    await expect(
      createAgentRoutine(
        prisma,
        { agentId: agent.id, slotMinutes: 4.5, activityType: "WORK", durationSimMinutes: 60 },
        { ...CTX, worldId },
      ),
    ).rejects.toThrow(/slot/i);
    await expect(
      createAgentRoutine(
        prisma,
        { agentId: agent.id, slotMinutes: 480, activityType: "WORK", durationSimMinutes: 0 },
        { ...CTX, worldId },
      ),
    ).rejects.toThrow(/duration/i);
    await expect(
      createAgentRoutine(
        prisma,
        { agentId: agent.id, slotMinutes: 480, activityType: "IDLE", durationSimMinutes: 60 },
        { ...CTX, worldId },
      ),
    ).rejects.toThrow(/activity/i);

    await expect(
      createAgentRoutine(
        prisma,
        { agentId: "missing-agent", slotMinutes: 480, activityType: "WORK", durationSimMinutes: 60 },
        { ...CTX, worldId },
      ),
    ).rejects.toThrow(/not found/i);

    await expect(
      createAgentRoutine(
        prisma,
        { agentId: agent.id, slotMinutes: 600, activityType: "WORK", durationSimMinutes: 60, locationId: foreign.id },
        { ...CTX, worldId },
      ),
    ).rejects.toThrow(/world/i);

    await expect(
      createAgentRoutine(
        prisma,
        { agentId: agent.id, slotMinutes: 600, activityType: "WORK", durationSimMinutes: 60, locationId: "missing-location" },
        { ...CTX, worldId },
      ),
    ).rejects.toThrow(/not found/i);

    await prisma.agent.update({ where: { id: agent.id }, data: { isActive: false } });
    await expect(
      createAgentRoutine(
        prisma,
        { agentId: agent.id, slotMinutes: 540, activityType: "REST", durationSimMinutes: 30 },
        { ...CTX, worldId },
      ),
    ).rejects.toThrow(/active/i);
  });

  it("updates a routine and emits ROUTINE_UPDATED", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });
    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 480, activityType: "WORK", durationSimMinutes: 60 },
      { ...CTX, worldId },
    );

    let seen: string | null = null;
    const off = eventBus.subscribe(EVENT_TYPES.ROUTINE_UPDATED, (event) => {
      seen = (event.payload as { activityType?: string }).activityType ?? null;
    });

    const updated = await updateAgentRoutine(
      prisma,
      routine.id,
      { slotMinutes: 540, activityType: "WORK" },
      { ...CTX, worldId },
    );
    off();
    expect(seen).toBe("WORK");
    expect(updated.slotMinutes).toBe(540);

    // Re-saving the routine's own slot is a no-op, not a conflict: the
    // uniqueness check excludes the row being updated.
    const same = await updateAgentRoutine(
      prisma,
      routine.id,
      { slotMinutes: 540, activityType: "WORK" },
      { ...CTX, worldId },
    );
    expect(same.slotMinutes).toBe(540);

    // Colliding with a DIFFERENT routine at the same slot still fails.
    const other = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 600, activityType: "REST", durationSimMinutes: 30 },
      { ...CTX, worldId },
    );
    await expect(
      updateAgentRoutine(prisma, other.id, { slotMinutes: 540, activityType: "WORK" }, { ...CTX, worldId }),
    ).rejects.toThrow(/already exists/i);

    const audit = await listActivity(prisma, { action: "routine.update", take: 5 });
    expect(audit.some((row) => row.targetId === routine.id)).toBe(true);
  });
});

describe("phase5 routine evaluation", () => {
  it("fires a due routine when the agent is free, opening an activity and entering the matching state", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });
    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 595, activityType: "WORK", durationSimMinutes: 60 },
      { ...CTX, worldId },
    );

    const evalResult = await evaluateAgentRoutines(prisma, { agentId: agent.id, simulatedNow: TEN }, { ...CTX, worldId });
    expect(evalResult.triggered.map((r) => r.id)).toEqual([routine.id]);
    expect(evalResult.skipped).toEqual([]);

    const open = await getOpenActivity(prisma, agent.id);
    expect(open?.type).toBe("WORK");
    expect(open?.status).toBe("ACTIVE");
    expect(JSON.parse(open?.metadata ?? "{}")).toMatchObject({ source: "routine", routineId: routine.id });

    const state = await getAgentState(prisma, agent.id);
    expect(state.state).toBe("WORKING");

    const reloaded = await prisma.agentRoutine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(reloaded.lastTriggeredSimDate).toBe(simDateKey(TEN));
    expect(reloaded.evaluatedOnSimDate).toBe(simDateKey(TEN));

    const triggered = await prisma.eventLog.findMany({
      where: { type: EVENT_TYPES.ROUTINE_TRIGGERED, targetId: routine.id },
    });
    expect(triggered.length).toBe(1);
    expect(JSON.parse(triggered[0]?.payload ?? "{}")).toMatchObject({
      agentId: agent.id,
      activityType: "WORK",
      slotMinutes: 595,
      reason: "on-time",
    });

    const audit = await listActivity(prisma, { action: "routine.triggered", take: 5 });
    expect(audit.some((row) => row.targetId === routine.id)).toBe(true);
  });

  it("never fires the same routine twice in one simulated day", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });
    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 595, activityType: "WORK", durationSimMinutes: 60 },
      { ...CTX, worldId },
    );

    await evaluateAgentRoutines(prisma, { agentId: agent.id, simulatedNow: TEN }, { ...CTX, worldId });
    const again = await evaluateAgentRoutines(prisma, { agentId: agent.id, simulatedNow: TEN }, { ...CTX, worldId });

    expect(again.triggered).toEqual([]);
    expect(again.skipped).toEqual([]);

    const triggered = await prisma.eventLog.findMany({
      where: { type: EVENT_TYPES.ROUTINE_TRIGGERED, targetId: routine.id },
    });
    expect(triggered.length).toBe(1);
  });

  it("fires the routine again on the next simulated day", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });
    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 595, activityType: "WORK", durationSimMinutes: 10 },
      { ...CTX, worldId },
    );

    await evaluateAgentRoutines(prisma, { agentId: agent.id, simulatedNow: TEN }, { ...CTX, worldId });
    const open = await getOpenActivity(prisma, agent.id);
    expect(open).not.toBeNull();
    await completeActivity(prisma, open?.id ?? "", { ...CTX, worldId }, {
      actualEndTime: new Date(TEN.getTime() + 10 * 60_000),
    });
    await changeAgentState(prisma, { agentId: agent.id, state: "IDLE" }, { ...CTX, worldId });

    const tomorrow = new Date(Date.UTC(2026, 2, 17, 10, 0, 0));
    const next = await evaluateAgentRoutines(prisma, { agentId: agent.id, simulatedNow: tomorrow }, { ...CTX, worldId });
    expect(next.triggered.map((r) => r.id)).toEqual([routine.id]);

    const reloaded = await prisma.agentRoutine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(reloaded.lastTriggeredSimDate).toBe(simDateKey(tomorrow));

    const triggered = await prisma.eventLog.findMany({
      where: { type: EVENT_TYPES.ROUTINE_TRIGGERED, targetId: routine.id },
    });
    expect(triggered.length).toBe(2);
  });

  it("skips a routine far past its slot as late-window without opening an activity", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });
    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 420, activityType: "WORK", durationSimMinutes: 60 },
      { ...CTX, worldId },
    );

    const evalResult = await evaluateAgentRoutines(prisma, { agentId: agent.id, simulatedNow: TEN }, { ...CTX, worldId });
    expect(evalResult.triggered).toEqual([]);
    expect(evalResult.skipped.map((r) => r.id)).toEqual([routine.id]);

    expect(await getOpenActivity(prisma, agent.id)).toBeNull();
    const state = await getAgentState(prisma, agent.id);
    expect(state.state).toBe("IDLE");

    const reloaded = await prisma.agentRoutine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(reloaded.evaluatedOnSimDate).toBe(simDateKey(TEN));
    expect(reloaded.lastTriggeredSimDate).toBeNull();

    const skipped = await prisma.eventLog.findMany({
      where: { type: EVENT_TYPES.ROUTINE_SKIPPED, targetId: routine.id },
    });
    expect(skipped.length).toBe(1);
    expect(JSON.parse(skipped[0]?.payload ?? "{}")).toMatchObject({ reason: "late-window" });

    const audit = await listActivity(prisma, { action: "routine.skipped", take: 5 });
    expect(audit.some((row) => row.targetId === routine.id)).toBe(true);
  });

  it("skips a routine whose required location the agent is not at", async () => {
    const { worldId, officeId, commonId } = await makeWorld();
    const agent = await createTestAgent({ worldId });
    await moveAgent(prisma, { agentId: agent.id, toLocationId: officeId }, { actor: SYSTEM });
    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 595, activityType: "WORK", durationSimMinutes: 60, locationId: commonId },
      { ...CTX, worldId },
    );

    const evalResult = await evaluateAgentRoutines(prisma, { agentId: agent.id, simulatedNow: TEN }, { ...CTX, worldId });
    expect(evalResult.triggered).toEqual([]);
    expect(evalResult.skipped.map((r) => r.id)).toEqual([routine.id]);
    expect(await getOpenActivity(prisma, agent.id)).toBeNull();

    const skipped = await prisma.eventLog.findMany({
      where: { type: EVENT_TYPES.ROUTINE_SKIPPED, targetId: routine.id },
    });
    expect(JSON.parse(skipped[0]?.payload ?? "{}")).toMatchObject({ reason: "not-at-location" });
  });

  it("skips a routine as state-mismatch instead of crashing when a transition is illegal", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });
    await changeAgentState(prisma, { agentId: agent.id, state: "SLEEPING" }, { ...CTX, worldId });
    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 595, activityType: "WORK", durationSimMinutes: 60 },
      { ...CTX, worldId },
    );

    const evalResult = await evaluateAgentRoutines(prisma, { agentId: agent.id, simulatedNow: TEN }, { ...CTX, worldId });
    expect(evalResult.triggered).toEqual([]);
    expect(evalResult.skipped.map((r) => r.id)).toEqual([routine.id]);
    expect(await getOpenActivity(prisma, agent.id)).toBeNull();
  });

  it("skips a routine as agent-busy when another activity is already open", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });
    await startActivity(prisma, { agentId: agent.id, type: "THINK" }, { ...CTX, worldId });
    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 595, activityType: "WORK", durationSimMinutes: 60 },
      { ...CTX, worldId },
    );

    const evalResult = await evaluateAgentRoutines(prisma, { agentId: agent.id, simulatedNow: TEN }, { ...CTX, worldId });
    expect(evalResult.triggered).toEqual([]);
    expect(evalResult.skipped.map((r) => r.id)).toEqual([routine.id]);

    const open = await getOpenActivity(prisma, agent.id);
    expect(open?.type).toBe("THINK");
  });
});

describe("phase5 routine engine integration", () => {
  it("fires a due routine on a tick and skips the decision engine for that agent", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });

    // Slot for 09:55 simulated: at the first tick the simulated clock is 10:00
    // (60 real seconds elapsed, timeScale 61), so the routine is due by only 5
    // minutes -- comfortably inside the grace window.
    const slot = 595;
    await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: slot, activityType: "WORK", durationSimMinutes: 60 },
      { ...CTX, worldId },
    );

    const engine = new SimulationEngine(prisma, {
      now: () => BASE,
      tickIntervalMs: 1_000,
      housekeepingEveryTicks: 0,
    });

    const first = await engine.tick({ at: BASE, worldId });
    expect(first.skipped).toBe(false);
    expect(first.routinesTriggered).toBe(1);
    expect(first.decisionsExecuted).toBe(0);
    expect(first.errors).toEqual([]);

    const open = await getOpenActivity(prisma, agent.id);
    expect(open?.type).toBe("WORK");
    const state = await getAgentState(prisma, agent.id);
    expect(state.state).toBe("WORKING");

    // A second tick within the same simulated day must not re-fire the routine.
    const second = await engine.tick({ at: new Date(BASE.getTime() + 30_000), worldId });
    expect(second.routinesTriggered).toBe(0);
    expect(second.routinesSkipped).toBe(0);
    engine.dispose();
  });
});