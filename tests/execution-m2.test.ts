import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../packages/database/src/client.js";
import {
  buildVerificationReport,
  cancelExecution,
  enqueueExecution,
  recoverOrphanedJobs,
  runJob,
} from "../packages/execution/src/index.js";
import { createWorkspace } from "../packages/workspace/src/index.js";
import { CORRELATION, SYSTEM, createTestAgent, unique } from "./helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "kw-m2-"));
}

async function workspace(root: string, scripts: Record<string, string> = {}) {
  const ws = await createWorkspace(
    prisma,
    { name: unique("M2 WS"), agentId: null, type: "TEMPORARY" },
    { actor: SYSTEM, correlationId: CORRELATION },
    { root },
  );
  for (const [name, source] of Object.entries(scripts)) writeFileSync(join(ws.path, name), source, "utf8");
  return ws;
}

async function queueNode(workspaceId: string, script: string, extra: Record<string, unknown> = {}) {
  return enqueueExecution(prisma, {
    kind: "COMMAND",
    command: JSON.stringify(["node", script]),
    actor: SYSTEM,
    correlationId: CORRELATION,
    backendId: "local",
    workspaceId,
    ...extra,
  });
}

async function eventTypes(jobId: string): Promise<string[]> {
  const rows = await prisma.eventLog.findMany({ where: { targetId: jobId }, orderBy: { createdAt: "asc" } });
  return rows.map((row) => row.type);
}

describe("idempotent creation", () => {
  it("returns the original job for a retried key, even under concurrency", async () => {
    const root = tempRoot();
    try {
      const ws = await workspace(root, { "a.js": "" });
      const key = unique("idem");
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() => queueNode(ws.id, "a.js", { idempotencyKey: key })),
      );
      expect(new Set(results.map((job) => job.id)).size).toBe(1);
      expect(await prisma.executionJob.count({ where: { idempotencyKey: key } })).toBe(1);
      expect(await prisma.eventLog.count({ where: { type: "EXECUTION_QUEUED", targetId: results[0]?.id } })).toBe(1);

      // The same key for a different request is a caller bug, not a replay.
      await expect(queueNode(ws.id, "b.js", { idempotencyKey: key })).rejects.toThrow(/different execution/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cancelling a running job", () => {
  it("kills the child, records CANCELLED and emits the lifecycle events", async () => {
    const root = tempRoot();
    try {
      const ws = await workspace(root, { "hang.js": "setInterval(() => {}, 1000)" });
      const job = await queueNode(ws.id, "hang.js", { timeoutMs: 60_000 });

      const run = runJob(prisma, job.id);
      for (let i = 0; i < 200; i += 1) {
        if ((await eventTypes(job.id)).includes("PROCESS_STARTED")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await cancelExecution(prisma, job.id, "operator stop", { actor: SYSTEM })).toBe("cancelling");

      const outcome = await run;
      expect(outcome).toMatchObject({ claimed: true, status: "CANCELLED" });
      const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe("CANCELLED");
      expect(row?.error).toBe("operator stop");

      const types = await eventTypes(job.id);
      for (const type of [
        "EXECUTION_QUEUED",
        "EXECUTION_CLAIMED",
        "EXECUTION_STARTED",
        "PROCESS_STARTED",
        "PROCESS_EXITED",
        "EXECUTION_CANCELLED",
        "EXECUTION_FINISHED",
      ]) {
        expect(types).toContain(type);
      }
      expect(types).not.toContain("EXECUTION_FAILED");
      expect(await cancelExecution(prisma, job.id, "again")).toBe("busy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits EXECUTION_FAILED for a nonzero exit", async () => {
    const root = tempRoot();
    try {
      const ws = await workspace(root, { "fail.js": "process.exit(2)" });
      const job = await queueNode(ws.id, "fail.js");
      expect(await runJob(prisma, job.id)).toMatchObject({ status: "FAILED", exitCode: 2 });
      const types = await eventTypes(job.id);
      expect(types).toContain("EXECUTION_FAILED");
      expect(types).toContain("PROCESS_EXITED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("orphan recovery", () => {
  it("requeues jobs with attempts left and fails the rest, never leaving RUNNING", async () => {
    const root = tempRoot();
    try {
      const ws = await workspace(root);
      const make = (attempts: number, maxAttempts: number) =>
        prisma.executionJob.create({
          data: {
            kind: "COMMAND",
            backendId: "local",
            workspaceId: ws.id,
            command: JSON.stringify(["node", "--version"]),
            status: "RUNNING",
            startedAt: new Date(Date.now() - 5_000),
            attempts,
            maxAttempts,
            correlationId: CORRELATION,
          },
        });
      const retryable = await make(1, 3);
      const exhausted = await make(2, 2);

      expect(await recoverOrphanedJobs(prisma, { all: true })).toBeGreaterThanOrEqual(2);
      const a = await prisma.executionJob.findUnique({ where: { id: retryable.id } });
      const b = await prisma.executionJob.findUnique({ where: { id: exhausted.id } });
      expect(a?.status).toBe("QUEUED");
      expect(b?.status).toBe("FAILED");
      expect(b?.errorCategory).toBe("SYSTEM");
      expect(await eventTypes(exhausted.id)).toContain("EXECUTION_RECOVERED");

      // A fresh RUNNING job inside its timeout is left alone by the periodic sweep.
      const fresh = await prisma.executionJob.create({
        data: { kind: "COMMAND", status: "RUNNING", startedAt: new Date(), timeoutMs: 600_000, correlationId: CORRELATION },
      });
      await recoverOrphanedJobs(prisma);
      expect((await prisma.executionJob.findUnique({ where: { id: fresh.id } }))?.status).toBe("RUNNING");
      await prisma.executionJob.update({ where: { id: fresh.id }, data: { status: "CANCELLED" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verification handoff to review", () => {
  async function runningTask(maxRetries: number) {
    const agent = await createTestAgent({ name: unique("Handoff Agent") });
    const task = await prisma.task.create({
      data: { title: "Handoff task", status: "RUNNING", assigneeAgentId: agent.id, maxRetries },
    });
    return { agent, task };
  }

  async function finishedJob(status: "COMPLETED" | "FAILED") {
    return prisma.executionJob.create({
      data: {
        kind: "VERIFY",
        status,
        command: JSON.stringify(["npm", "test"]),
        exitCode: status === "COMPLETED" ? 0 : 1,
        finishedAt: new Date(),
        correlationId: CORRELATION,
      },
    });
  }

  it("moves a green task to REVIEWING and keeps a red one with its assignee within budget", async () => {
    const green = await runningTask(2);
    const ok = await finishedJob("COMPLETED");
    const report = await buildVerificationReport(prisma, [ok.id], { actor: SYSTEM, correlationId: CORRELATION }, { taskId: green.task.id });
    expect(report.kind).toBe("EXECUTION");
    expect((await prisma.task.findUnique({ where: { id: green.task.id } }))?.status).toBe("REVIEWING");
    expect(await prisma.eventLog.count({ where: { type: "VERIFICATION_FINISHED", targetId: report.id } })).toBe(1);

    const red = await runningTask(2);
    const bad = await finishedJob("FAILED");
    const failing = await buildVerificationReport(prisma, [bad.id], { actor: SYSTEM, correlationId: CORRELATION }, { taskId: red.task.id });
    expect((await prisma.task.findUnique({ where: { id: red.task.id } }))?.status).toBe("RUNNING");
    expect(await prisma.eventLog.count({ where: { type: "VERIFICATION_FAILED", targetId: failing.id } })).toBe(1);
  });

  it("fails the task and escalates once failed verifications exceed maxRetries", async () => {
    const { agent, task } = await runningTask(1);
    for (let i = 0; i < 2; i += 1) {
      const bad = await finishedJob("FAILED");
      await buildVerificationReport(prisma, [bad.id], { actor: SYSTEM, correlationId: CORRELATION }, { taskId: task.id });
    }
    const after = await prisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe("FAILED");
    expect(after?.error).toBe("Verification failed repeatedly");
    const escalations = await prisma.escalation.findMany({ where: { taskId: task.id, fromAgentId: agent.id } });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.category).toBe("REPEATED_FAILURE");
  });
});
