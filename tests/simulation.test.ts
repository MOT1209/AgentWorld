import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { canTransitionAgentState } from "../packages/shared/src/index.js";
import { SYSTEM, createTestAgent, unique } from "./helpers.js";
import {
  DEFAULT_PERSONALITY,
  DeterministicDecisionEngine,
  SimulationEngine,
  applyNeedsTick,
  criticalNeeds,
  defaultPersonalityForRole,
  getOpenActivity,
  grantSkillExperience,
  needsFromInitial,
  parsePersonality,
  parseSkills,
  startActivity,
  completeActivity,
  skillForActivity,
} from "../packages/simulation/src/index.js";
import { getAgentState } from "../packages/agents/src/index.js";
import { EVENT_TYPES } from "../packages/events/src/index.js";

const CTX = { actor: SYSTEM, correlationId: "sim-test" };

/** Deterministic "now": local 10:00, inside the WORK phase of the simulated day. */
const BASE = new Date(2026, 2, 15, 10, 0, 0);

async function makeWorld(): Promise<{ worldId: string; officeId: string; commonId: string }> {
  const world = await prisma.world.create({
    data: {
      name: unique("Sim World"),
      timeScale: 61,
      status: "RUNNING",
      timeOffsetMinutes: 0,
      lastTickAt: new Date(BASE.getTime() - 60_000),
    },
  });
  const city = await prisma.city.create({
    data: { worldId: world.id, name: unique("Sim City"), kind: "CAPITAL" },
  });
  const office = await prisma.location.create({
    data: { cityId: city.id, name: unique("Office"), kind: "OFFICE" },
  });
  const common = await prisma.location.create({
    data: { cityId: city.id, name: unique("Common"), kind: "PUBLIC_SPACE" },
  });
  return { worldId: world.id, officeId: office.id, commonId: common.id };
}

describe("personality", () => {
  it("biases role defaults without branching on agent identity", () => {
    const planner = defaultPersonalityForRole("PLANNER");
    const executor = defaultPersonalityForRole("EXECUTOR");
    expect(planner.workPreference).toBe("FOCUSED");
    expect(executor.workPreference).toBe("COLLABORATIVE");
    expect(planner.conscientiousness).toBeGreaterThan(DEFAULT_PERSONALITY.conscientiousness);
  });

  it("treats empty/legacy/unknown payloads as the role default", () => {
    expect(parsePersonality("{}", "ANALYST").communicationStyle).toBe("DETAILED");
    expect(parsePersonality("not-json", "EXECUTOR").workPreference).toBe("COLLABORATIVE");
    expect(parsePersonality(null).openness).toBe(DEFAULT_PERSONALITY.openness);
  });
});

describe("needs", () => {
  it("recovers energy during sleep and reports changed needs", () => {
    const vitals = { needs: needsFromInitial({ ENERGY: 40 }) };
    const { needs, changed } = applyNeedsTick(vitals, "SLEEP", 120);
    expect(needs.ENERGY).toBeGreaterThan(40);
    expect(changed).toContain("ENERGY");
  });

  it("clamps need values into 0..100", () => {
    const { needs } = applyNeedsTick({ needs: needsFromInitial({ ENERGY: 99 }) }, "SLEEP", 10_000);
    expect(needs.ENERGY).toBe(100);
  });

  it("identifies critical needs most-urgent first", () => {
    const vitals = { needs: needsFromInitial({ ENERGY: 5, HUNGER: 15, SOCIAL: 90 }) };
    const critical = criticalNeeds(vitals.needs);
    expect(critical).toEqual(["ENERGY", "HUNGER"]);
  });
});

describe("skills", () => {
  it("rolls experience over into levels", () => {
    const result = grantSkillExperience([], "Planning", 100);
    expect(result.leveledUp).toBe(true);
    expect(result.skill.level).toBe(2);
    expect(result.skill.experience).toBe(0);
  });

  it("accepts the legacy string[] column shape", () => {
    const skills = parseSkills(JSON.stringify(["planning", "review"]));
    expect(skills.map((s) => s.name)).toEqual(["planning", "review"]);
  });

  it("maps activities to the skill they train", () => {
    const skills = parseSkills(JSON.stringify(["Execution"]));
    expect(skillForActivity("WORK", skills)).toBe("Execution");
    expect(skillForActivity("REST", skills)).toBeNull();
  });
});

describe("decision engine", () => {
  const engine = new DeterministicDecisionEngine();

  it("rests an agent whose energy is critical", () => {
    const decision = engine.decide({
      agentId: "a",
      state: "IDLE",
      needs: needsFromInitial({ ENERGY: 10 }),
      phase: "WORK",
      hasOpenActivity: false,
      currentLocationId: null,
      workLocationId: "w",
      commonLocationId: "c",
    });
    expect(decision.action).toBe("REST");
  });

  it("moves to the work location during working hours", () => {
    const decision = engine.decide({
      agentId: "a",
      state: "IDLE",
      needs: needsFromInitial(),
      phase: "WORK",
      hasOpenActivity: false,
      currentLocationId: null,
      workLocationId: "w",
      commonLocationId: "c",
    });
    expect(decision.action).toBe("MOVE");
    expect(decision.metadata.toLocationId).toBe("w");
  });

  it("starts WORK once already at the work location", () => {
    const decision = engine.decide({
      agentId: "a",
      state: "IDLE",
      needs: needsFromInitial(),
      phase: "WORK",
      hasOpenActivity: false,
      currentLocationId: "w",
      workLocationId: "w",
      commonLocationId: "c",
    });
    expect(decision.action).toBe("START_ACTIVITY");
    expect(decision.metadata.activityType).toBe("WORK");
  });
});

describe("agent state transitions", () => {
  it("allows a legal work lifecycle but refuses ERROR shortcuts", () => {
    expect(canTransitionAgentState("IDLE", "WORKING")).toBe(true);
    expect(canTransitionAgentState("WORKING", "IDLE")).toBe(true);
    expect(canTransitionAgentState("OFFLINE", "WORKING")).toBe(false);
    expect(canTransitionAgentState("ERROR", "WORKING")).toBe(false);
  });
});

describe("activities", () => {
  it("keeps at most one open activity and computes duration on completion", async () => {
    const { worldId } = await makeWorld();
    const agent = await createTestAgent({ worldId });

    const started = await startActivity(
      prisma,
      {
        agentId: agent.id,
        type: "WORK",
        startTime: BASE,
        expectedEndTime: new Date(BASE.getTime() + 60 * 60_000),
        active: true,
      },
      { ...CTX, worldId },
    );
    expect(started.status).toBe("ACTIVE");

    await expect(
      startActivity(prisma, { agentId: agent.id, type: "REST" }, { ...CTX, worldId }),
    ).rejects.toThrow();

    const { activity, durationSimMinutes } = await completeActivity(prisma, started.id, { ...CTX, worldId }, {
      actualEndTime: new Date(BASE.getTime() + 45 * 60_000),
    });
    expect(activity.status).toBe("COMPLETED");
    expect(durationSimMinutes).toBeCloseTo(45, 5);
    expect(await getOpenActivity(prisma, agent.id)).toBeNull();
  });
});

describe("simulation engine", () => {
  it("advances the clock, moves the agent, then starts a work activity", async () => {
    const { worldId, officeId } = await makeWorld();
    const agent = await createTestAgent({ worldId });

    const engine = new SimulationEngine(prisma, {
      now: () => BASE,
      tickIntervalMs: 1_000,
      housekeepingEveryTicks: 0,
    });

    const first = await engine.tick({ at: BASE, worldId });
    expect(first.skipped).toBe(false);
    expect(first.agentsProcessed).toBe(1);
    expect(first.elapsedSimMinutes).toBeGreaterThan(0);

    const moved = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(moved.currentLocationId).toBe(officeId);

    const second = await engine.tick({ at: new Date(BASE.getTime() + 30_000), worldId });
    expect(second.decisionsExecuted).toBeGreaterThanOrEqual(1);

    const open = await getOpenActivity(prisma, agent.id);
    expect(open?.type).toBe("WORK");

    const state = await getAgentState(prisma, agent.id);
    expect(state.state).toBe("WORKING");

    const event = await prisma.eventLog.findFirst({
      where: { type: EVENT_TYPES.AGENT_ACTIVITY_STARTED, targetId: open?.id ?? "" },
    });
    expect(event).not.toBeNull();

    const snapshot = await engine.getState(worldId);
    expect(snapshot.world.id).toBe(worldId);
    expect(snapshot.counts.agents).toBe(1);
    expect(snapshot.agents[0]?.needs.ENERGY).toBeGreaterThan(0);
  });

  it("does not tick a world that is not RUNNING", async () => {
    const { worldId } = await makeWorld();
    await prisma.world.update({ where: { id: worldId }, data: { status: "PAUSED" } });
    const engine = new SimulationEngine(prisma, { now: () => BASE, tickIntervalMs: 1_000 });
    const result = await engine.tick({ at: BASE, worldId });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("world-paused");
    engine.dispose();
  });
});
