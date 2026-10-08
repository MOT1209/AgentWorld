/**
 * Phase 6 social + academy tests: relationships, performance, evolution,
 * academy training runs, and the idempotent payroll cycle. Every score here
 * comes from recorded evidence -- the tests create that evidence first and
 * assert the services derive the same numbers.
 */
import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { Money } from "../packages/shared/src/index.js";
import {
  recordInteraction,
  listRelationships,
  getRelationship,
  closestPeers,
  agentPerformance,
  evolveReputation,
  startTrainingRun,
  evaluateTrainingRun,
  failTrainingRun,
  listTrainingRuns,
} from "../packages/agents/src/index.js";
import { runPayrollCycle, dailySalaryMinor, payrollDayKey } from "../packages/economy/src/index.js";
import { fundTreasury } from "../packages/economy/src/treasury.service.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { SYSTEM, CORRELATION, createTestUser, createTestAgent, unique } from "./helpers.js";

const CTX = { actor: SYSTEM, correlationId: CORRELATION };

async function createCompanyWithMember(salaryMinor: number): Promise<{ companyId: string; agentId: string }> {
  const user = await createTestUser();
  const company = await prisma.company.create({
    data: { name: unique("Payroll Co"), ownerId: user.id },
  });
  const agent = await createTestAgent({ companyId: company.id });
  await prisma.companyMember.create({
    data: {
      companyId: company.id,
      agentId: agent.id,
      title: "Worker",
      roleKey: "EXECUTOR",
      salaryMinor,
    },
  });
  return { companyId: company.id, agentId: agent.id };
}

describe("relationships", () => {
  it("creates an edge from an observed interaction and clamps scores", async () => {
    const a = await createTestAgent();
    const b = await createTestAgent();

    const edge = await recordInteraction(prisma, {
      sourceAgentId: a.id,
      targetAgentId: b.id,
      kind: "COLLABORATION",
    }, CTX);
    expect(edge.interactionCount).toBe(1);
    expect(edge.affinity).toBe(4);
    expect(edge.trust).toBe(53);

    const again = await recordInteraction(prisma, {
      sourceAgentId: a.id,
      targetAgentId: b.id,
      kind: "COLLABORATION",
    }, CTX);
    expect(again.interactionCount).toBe(2);

    const listed = await listRelationships(prisma, a.id);
    expect(listed).toHaveLength(1);
    const got = await getRelationship(prisma, a.id, b.id);
    expect(got?.id).toBe(edge.id);
  });

  it("refuses self-relationships and unknown agents", async () => {
    const a = await createTestAgent();
    await expect(
      recordInteraction(prisma, { sourceAgentId: a.id, targetAgentId: a.id, kind: "CONVERSATION" }, CTX),
    ).rejects.toThrow();
    await expect(
      recordInteraction(prisma, { sourceAgentId: a.id, targetAgentId: "ghost", kind: "CONVERSATION" }, CTX),
    ).rejects.toThrow();
  });

  it("ranks closest peers by measured affinity", async () => {
    const a = await createTestAgent();
    const b = await createTestAgent();
    const c = await createTestAgent();
    await recordInteraction(prisma, { sourceAgentId: a.id, targetAgentId: b.id, kind: "COLLABORATION" }, CTX);
    await recordInteraction(prisma, { sourceAgentId: a.id, targetAgentId: c.id, kind: "CO_LOCATION" }, CTX);
    const peers = await closestPeers(prisma, a.id, 5);
    expect(peers[0]?.targetAgentId).toBe(b.id);
  });
});

describe("performance center", () => {
  it("derives task/review/execution metrics from recorded history", async () => {
    const agent = await createTestAgent();
    await prisma.task.create({
      data: {
        title: unique("Done task"),
        status: "COMPLETED",
        assigneeAgentId: agent.id,
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      },
    });
    await prisma.task.create({
      data: { title: unique("Failed task"), status: "FAILED", assigneeAgentId: agent.id },
    });

    const summary = await agentPerformance(prisma, agent.id);
    expect(summary.tasks.total).toBe(2);
    expect(summary.tasks.completed).toBe(1);
    expect(summary.tasks.failed).toBe(1);
    expect(summary.tasks.successRate).toBe(50);
    expect(summary.tasks.avgDurationMs).not.toBeNull();
  });

  it("throws for a nonexistent agent", async () => {
    await expect(agentPerformance(prisma, "ghost")).rejects.toThrow();
  });
});

describe("agent evolution", () => {
  it("moves reputation from measured evidence and emits the change", async () => {
    const agent = await createTestAgent();
    for (let i = 0; i < 3; i++) {
      await prisma.task.create({
        data: { title: unique("Good task"), status: "COMPLETED", assigneeAgentId: agent.id },
      });
    }
    const before = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { reputation: true } });

    const result = await evolveReputation(prisma, agent.id, CTX);
    expect(result.delta).toBeGreaterThan(0);
    expect(result.toReputation).toBe(before.reputation + result.delta);
    expect(result.reason).toContain("measured-success");

    const after = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { reputation: true } });
    expect(after.reputation).toBe(result.toReputation);

    const event = await prisma.eventLog.findFirst({
      where: { type: "AGENT_REPUTATION_CHANGED", targetId: agent.id },
      orderBy: { id: "desc" },
    });
    expect(event).not.toBeNull();
  });

  it("does not judge a thin sample", async () => {
    const agent = await createTestAgent();
    await prisma.task.create({
      data: { title: unique("Single task"), status: "COMPLETED", assigneeAgentId: agent.id },
    });
    const before = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { reputation: true } });
    const result = await evolveReputation(prisma, agent.id, CTX);
    // One task out of MIN_SAMPLE=3 gives a small, bounded move -- never a swing.
    expect(Math.abs(result.delta)).toBeLessThanOrEqual(2);
    expect(result.toReputation).toBe(before.reputation + result.delta);
  });
});

describe("academy", () => {
  it("grants a skill only on a passed evaluation", async () => {
    const agent = await createTestAgent();

    const run = await startTrainingRun(prisma, { agentId: agent.id, skillName: "Negotiation" }, CTX);
    expect(run.status).toBe("RUNNING");
    expect(run.passingScore).toBe(70);

    const evaluated = await evaluateTrainingRun(prisma, run.id, { score: 85, feedback: "solid" }, CTX);
    expect(evaluated.status).toBe("EVALUATED");
    expect(evaluated.score).toBe(85);

    const agentRow = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { skills: true } });
    expect(JSON.parse(agentRow.skills)).toContain("Negotiation");

    const event = await prisma.eventLog.findFirst({
      where: { type: "EVALUATION_RECORDED", targetId: run.id },
      orderBy: { id: "desc" },
    });
    expect(event).not.toBeNull();
  });

  it("keeps a failed run as evidence without granting the skill", async () => {
    const agent = await createTestAgent();
    const run = await startTrainingRun(prisma, { agentId: agent.id, skillName: "Bargaining" }, CTX);
    await evaluateTrainingRun(prisma, run.id, { score: 40 }, CTX);
    const agentRow = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { skills: true } });
    expect(JSON.parse(agentRow.skills)).not.toContain("Bargaining");
  });

  it("evaluates each run exactly once", async () => {
    const agent = await createTestAgent();
    const run = await startTrainingRun(prisma, { agentId: agent.id, skillName: "Planning" }, CTX);
    await evaluateTrainingRun(prisma, run.id, { score: 90 }, CTX);
    await expect(evaluateTrainingRun(prisma, run.id, { score: 95 }, CTX)).rejects.toThrow();
  });

  it("records a terminal failure without a score", async () => {
    const agent = await createTestAgent();
    const run = await startTrainingRun(prisma, { agentId: agent.id, skillName: "Archery" }, CTX);
    const failed = await failTrainingRun(prisma, run.id, "evaluator crashed", CTX);
    expect(failed.status).toBe("FAILED");
    expect(failed.score).toBeNull();

    const listed = await listTrainingRuns(prisma, agent.id, { status: "FAILED" });
    expect(listed.map((r) => r.id)).toContain(failed.id);
  });
});

describe("payroll cycle", () => {
  it("pays the daily share once per day and replays as a no-op", async () => {
    const { companyId, agentId } = await createCompanyWithMember(36500); // 100/day
    await fundTreasury({ companyId, amount: Money.fromMinor(1000), description: "seed", ...CTX });

    const day = new Date("2026-10-08T12:00:00.000Z");
    const first = await runPayrollCycle(prisma, { simulatedNow: day, companyId }, CTX);
    expect(first.paid).toHaveLength(1);
    expect(first.paid[0]?.amountMinor).toBe(100);
    expect(first.paid[0]?.replayed).toBe(false);

    const second = await runPayrollCycle(prisma, { simulatedNow: day, companyId }, CTX);
    expect(second.paid).toHaveLength(1);
    expect(second.paid[0]?.replayed).toBe(true);

    const wallet = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: agentId });
    expect(wallet.balanceMinor).toBe(100);

    // Ledger transfer legs are recorded as TRANSFER; the payroll key identifies them.
    const txs = await prisma.transaction.findMany({
      where: { walletId: wallet.id, idempotencyKey: `payroll:${companyId}:${agentId}:2026-10-08` },
    });
    expect(txs).toHaveLength(1);
  });

  it("records shortfalls when the treasury cannot cover payroll", async () => {
    const { companyId, agentId } = await createCompanyWithMember(3650000); // 10000/day
    await fundTreasury({ companyId, amount: Money.fromMinor(100), description: "seed", ...CTX });

    const cycle = await runPayrollCycle(
      prisma,
      { simulatedNow: new Date("2026-10-09T12:00:00.000Z"), companyId },
      CTX,
    );
    expect(cycle.paid).toHaveLength(0);
    expect(cycle.shortfalls).toHaveLength(1);
    expect(cycle.shortfalls[0]?.companyId).toBe(companyId);
    expect(cycle.shortfalls[0]?.agentId).toBe(agentId);
  });

  it("computes the daily share deterministically", () => {
    expect(dailySalaryMinor(36500)).toBe(100);
    expect(dailySalaryMinor(0)).toBe(0);
    expect(dailySalaryMinor(36499)).toBe(99);
    expect(() => dailySalaryMinor(-1)).toThrow();
    expect(payrollDayKey(new Date("2026-10-08T23:59:59.000Z"))).toBe("2026-10-08");
  });
});
