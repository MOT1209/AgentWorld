import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { riskForAction } from "../packages/approvals/src/approval-policy.js";
import { createDefaultRegistry, ToolExecutor } from "../packages/tools/src/index.js";
import {
  startSession,
  getSession,
  listSessions,
  transitionSession,
  appendSessionToolCall,
  finishSession,
} from "../packages/runtime/src/index.js";
import {
  submitReview,
  listReviews,
} from "../packages/orchestration/src/index.js";
import { writeReport } from "../packages/orchestration/src/report.service.js";
import {
  raiseEscalation,
  resolveEscalation,
  acknowledgeEscalation,
  listHumanEscalations,
} from "../packages/orchestration/src/escalation.service.js";
import { createTask, updateTask } from "../packages/tasks/src/index.js";
import { routeModel } from "../packages/ai/src/index.js";
import type { Permission } from "../packages/security/src/permissions.js";
import { SYSTEM, CORRELATION, createTestAgent, unique } from "./helpers.js";

const REVIEW_PERMS = new Set<Permission>(["task.review"]);
const REPORT_PERMS = new Set<Permission>(["report.create"]);
const ESCALATE_PERMS = new Set<Permission>(["agent.escalate"]);
const SESSION_PERMS = new Set<Permission>(["session.start", "session.read"]);
const PLAN_PERMS = new Set<Permission>(["plan.create", "plan.update", "plan.read"]);

function executorWith(perms: Permission[], agentId?: string): { executor: ToolExecutor; ctx: Parameters<ToolExecutor["invoke"]>[2] } {
  const executor = new ToolExecutor({ registry: createDefaultRegistry() });
  return {
    executor,
    ctx: {
      ...(agentId !== undefined ? { agentId } : {}),
      actor: agentId !== undefined ? { actorType: "AGENT" as const, actorId: agentId } : SYSTEM,
      correlationId: CORRELATION,
      permissions: new Set(perms),
      db: prisma,
      now: new Date(),
    },
  };
}

async function reviewingTask(): Promise<{ taskId: string; workerId: string; reviewerId: string }> {
  const worker = await createTestAgent({ name: "Review Worker" });
  const reviewer = await createTestAgent({ name: "Review Judge" });
  const task = await createTask(prisma, { title: unique("Reviewable work"), assigneeAgentId: worker.id }, { actor: SYSTEM });
  await updateTask(prisma, task.id, { status: "RUNNING" }, { actor: SYSTEM, agentId: worker.id });
  await updateTask(prisma, task.id, { status: "REVIEWING" }, { actor: SYSTEM, agentId: worker.id });
  return { taskId: task.id, workerId: worker.id, reviewerId: reviewer.id };
}

describe("sessions", () => {
  it("runs the full lifecycle with ownership and terminal finality", async () => {
    const agent = await createTestAgent({ name: "Session Owner" });
    const other = await createTestAgent({ name: "Session Stranger" });

    const session = await startSession(
      prisma,
      { agentId: agent.id, trigger: "TASK_ASSIGNED", context: { taskType: "IMPLEMENTATION" } },
      { actor: SYSTEM, correlationId: CORRELATION, permissions: SESSION_PERMS, agentId: agent.id },
    );
    expect(session.status).toBe("INITIALIZING");
    expect(session.providerId).toBe("mock");

    await expect(
      startSession(prisma, { agentId: agent.id }, { actor: SYSTEM, correlationId: CORRELATION, permissions: SESSION_PERMS, agentId: other.id }),
    ).rejects.toThrow();

    const running = await transitionSession(prisma, session.id, "RUNNING", {
      actor: SYSTEM, correlationId: CORRELATION, agentId: agent.id,
    });
    expect(running.status).toBe("RUNNING");

    await appendSessionToolCall(prisma, session.id, { name: "task.list", status: "SUCCESS", durationMs: 12 }, {
      actor: SYSTEM, correlationId: CORRELATION, agentId: agent.id,
    });

    const finished = await finishSession(prisma, session.id, { status: "COMPLETED", result: "done" }, {
      actor: SYSTEM, correlationId: CORRELATION, agentId: agent.id,
    });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.endedAt).not.toBeNull();

    await expect(
      transitionSession(prisma, session.id, "RUNNING", { actor: SYSTEM, correlationId: CORRELATION, agentId: agent.id }),
    ).rejects.toThrow();

    await expect(
      getSession(prisma, session.id),
    ).resolves.toBeDefined();

    const mine = await listSessions(prisma, { agentId: agent.id });
    expect(mine.some((s) => s.id === session.id)).toBe(true);

    const started = await prisma.eventLog.count({ where: { type: "SESSION_STARTED" } });
    const done = await prisma.eventLog.count({ where: { type: "SESSION_FINISHED" } });
    expect(started).toBeGreaterThan(0);
    expect(done).toBeGreaterThan(0);
  });

  it("rejects unknown agents and bad triggers", async () => {
    await expect(
      startSession(prisma, { agentId: "does-not-exist" }, { actor: SYSTEM, correlationId: CORRELATION }),
    ).rejects.toThrow();
    const agent = await createTestAgent({ name: "Bad Trigger" });
    await expect(
      startSession(prisma, { agentId: agent.id, trigger: "DREAMING" }, { actor: SYSTEM, correlationId: CORRELATION }),
    ).rejects.toThrow();
  });
});

describe("reviews", () => {
  it("approves, reworks within budget, fails past it, and bans self-review", async () => {
    const { taskId, reviewerId } = await reviewingTask();
    const reviewerCtx = { actor: { actorType: "AGENT" as const, actorId: reviewerId }, correlationId: CORRELATION, permissions: REVIEW_PERMS, agentId: reviewerId };

    const approved = await submitReview(prisma, { taskId, outcome: "APPROVED", notes: "Solid work, all criteria met here" }, reviewerCtx);
    expect(approved.task.status).toBe("COMPLETED");

    const second = await reviewingTask();
    const needs = await submitReview(
      prisma,
      { taskId: second.taskId, outcome: "NEEDS_CHANGES", notes: "Missing edge case handling entirely" },
      { actor: { actorType: "AGENT" as const, actorId: second.reviewerId }, correlationId: CORRELATION, permissions: REVIEW_PERMS, agentId: second.reviewerId },
    );
    expect(needs.task.status).toBe("ASSIGNED");
    const reread = await prisma.task.findUniqueOrThrow({ where: { id: second.taskId } });
    expect(reread.reworkCount).toBe(1);

    await expect(
      submitReview(
        prisma,
        { taskId, outcome: "NEEDS_CHANGES", notes: "Trying to judge an already completed task" },
        reviewerCtx,
      ),
    ).rejects.toThrow();

    // Self-review ban, exercised precisely: back to REVIEWING, then the
    // assignee judges its own work.
    await updateTask(prisma, second.taskId, { status: "RUNNING" }, { actor: SYSTEM });
    await updateTask(prisma, second.taskId, { status: "REVIEWING" }, { actor: SYSTEM, agentId: second.workerId });
    await expect(
      submitReview(
        prisma,
        { taskId: second.taskId, outcome: "APPROVED", notes: "Worker judging its own assigned work now" },
        { actor: { actorType: "AGENT" as const, actorId: second.workerId }, correlationId: CORRELATION, permissions: REVIEW_PERMS, agentId: second.workerId },
      ),
    ).rejects.toThrow();

    const reviews = await listReviews(prisma, taskId);
    expect(reviews.length).toBe(1);
    const reviewed = await prisma.eventLog.count({ where: { type: "TASK_REVIEWED" } });
    expect(reviewed).toBeGreaterThan(0);
  });

  it("fails the task and escalates when the rework budget is exhausted", async () => {
    const { taskId, reviewerId } = await reviewingTask();
    const reviewerCtx = { actor: { actorType: "AGENT" as const, actorId: reviewerId }, correlationId: CORRELATION, permissions: REVIEW_PERMS, agentId: reviewerId };
    await prisma.task.update({ where: { id: taskId }, data: { maxRetries: 0 } });

    const failed = await submitReview(
      prisma,
      { taskId, outcome: "NEEDS_CHANGES", notes: "Still broken and no budget left for fixes" },
      reviewerCtx,
    );
    expect(failed.task.status).toBe("FAILED");

    const escalations = await prisma.escalation.findMany({ where: { taskId, category: "REPEATED_FAILURE" } });
    expect(escalations.length).toBe(1);
  });

  it("rejects outright and escalates with a block", async () => {
    const first = await reviewingTask();
    const reviewerCtx = { actor: { actorType: "AGENT" as const, actorId: first.reviewerId }, correlationId: CORRELATION, permissions: REVIEW_PERMS, agentId: first.reviewerId };
    const rejected = await submitReview(
      prisma,
      { taskId: first.taskId, outcome: "REJECTED", notes: "Fundamentally wrong approach, start over" },
      reviewerCtx,
    );
    expect(rejected.task.status).toBe("FAILED");

    const second = await reviewingTask();
    const blocked = await submitReview(
      prisma,
      { taskId: second.taskId, outcome: "ESCALATE", notes: "Needs a human decision on scope first" },
      { actor: { actorType: "AGENT" as const, actorId: second.reviewerId }, correlationId: CORRELATION, permissions: REVIEW_PERMS, agentId: second.reviewerId },
    );
    expect(blocked.task.status).toBe("BLOCKED");
  });
});

describe("reports and escalations", () => {
  it("writes attributed reports", async () => {
    const agent = await createTestAgent({ name: "Reporter" });
    const report = await writeReport(
      prisma,
      { kind: "PROGRESS", summary: "Halfway through the assigned implementation work", payload: { workCompleted: ["scaffold"] } },
      { actor: { actorType: "AGENT", actorId: agent.id }, correlationId: CORRELATION, permissions: REPORT_PERMS, agentId: agent.id },
    );
    expect(report.authorAgentId).toBe(agent.id);
    const written = await prisma.eventLog.count({ where: { type: "REPORT_WRITTEN" } });
    expect(written).toBeGreaterThan(0);
  });

  it("raises, acknowledges, and resolves with recipient rules", async () => {
    const raiser = await createTestAgent({ name: "Raiser" });
    const boss = await createTestAgent({ name: "Boss" });
    const raised = await raiseEscalation(
      prisma,
      { fromAgentId: raiser.id, toAgentId: boss.id, category: "BLOCKED", detail: "Waiting on credentials I cannot mint myself" },
      { actor: { actorType: "AGENT", actorId: raiser.id }, correlationId: CORRELATION, permissions: ESCALATE_PERMS, agentId: raiser.id },
    );
    expect(raised.status).toBe("OPEN");

    await expect(
      resolveEscalation(prisma, { escalationId: raised.id, outcome: "RESOLVED", resolution: "I fix it myself" }, {
        actor: { actorType: "AGENT", actorId: raiser.id }, correlationId: CORRELATION, agentId: raiser.id,
      }),
    ).rejects.toThrow();

    const acked = await acknowledgeEscalation(prisma, raised.id, {
      actor: { actorType: "AGENT", actorId: boss.id }, correlationId: CORRELATION, agentId: boss.id,
    });
    expect(acked.status).toBe("ACKNOWLEDGED");

    const resolved = await resolveEscalation(prisma, { escalationId: raised.id, outcome: "RESOLVED", resolution: "Credentials issued out of band" }, {
      actor: { actorType: "AGENT", actorId: boss.id }, correlationId: CORRELATION, agentId: boss.id,
    });
    expect(resolved.status).toBe("RESOLVED");

    const humans = await listHumanEscalations(prisma);
    expect(humans.every((e) => e.id !== raised.id)).toBe(true);
  });
});

describe("orchestration tools", () => {
  it("exposes plan, review, report, escalate, and session tools", async () => {
    const planner = await createTestAgent({ name: "Tool Planner", roleKey: "PLANNER" });
    const { executor, ctx } = executorWith(
      [...PLAN_PERMS, ...REVIEW_PERMS, ...REPORT_PERMS, ...ESCALATE_PERMS, ...SESSION_PERMS],
      planner.id,
    );

    const created = await executor.invoke("plan.create", { title: unique("Tool plan"), objective: "Objective stated with enough words here" }, ctx);
    expect(created.status).toBe("SUCCESS");

    const started = await executor.invoke("session.start", { trigger: "MANUAL" }, ctx);
    expect(started.status).toBe("SUCCESS");
    const sessionId = (started.data as { id: string }).id;

    const status = await executor.invoke("session.status", { sessionId }, ctx);
    expect(status.status).toBe("SUCCESS");

    const reported = await executor.invoke("report.submit", { kind: "PROGRESS", summary: "Tool-driven progress report content" }, ctx);
    expect(reported.status).toBe("SUCCESS");

    const escalated = await executor.invoke("agent.escalate", { category: "BLOCKED", detail: "Tool-driven escalation with enough detail" }, ctx);
    expect(escalated.status).toBe("SUCCESS");
  });

  it("runs review.submit end to end through the executor", async () => {
    const { taskId, reviewerId } = await reviewingTask();
    const { executor, ctx } = executorWith([...REVIEW_PERMS], reviewerId);
    const result = await executor.invoke(
      "review.submit",
      { taskId, outcome: "APPROVED", notes: "Executor-driven approval with rationale" },
      ctx,
    );
    expect(result.status).toBe("SUCCESS");
    expect((result.data as { taskStatus: string }).taskStatus).toBe("COMPLETED");
  });
});

describe("action risk registry", () => {
  it("classifies the previously unknown LOW tools", () => {
    for (const action of ["task.detail", "memory.forget", "wallet.statement", "approval.list", "approval.get"]) {
      expect(riskForAction(action)).toBe("LOW");
    }
    expect(riskForAction("approval.decide")).toBe("CRITICAL");
  });
});

describe("model router", () => {
  it("routes explicitly, by model, and falls back honestly", () => {
    const plain = routeModel({});
    expect(plain.providerId).toBe("mock");
    expect(plain.fallback).toBe(false);

    const coding = routeModel({ capability: "software" });
    expect(coding.providerId).toBe("mock");
    expect(coding.fallback).toBe(true);

    const explicit = routeModel({ providerId: "mock" });
    expect(explicit.reason).toBe("explicit");

    const byModel = routeModel({ model: "deterministic-scheduler-v1" });
    expect(byModel.providerId).toBe("mock");

    expect(() => routeModel({ providerId: "no-such-provider" })).toThrow();
    expect(() => routeModel({ model: "no-such-model" })).toThrow();
  });
});
