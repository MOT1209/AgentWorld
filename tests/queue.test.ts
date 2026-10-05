import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../packages/database/src/client.js";
import {
  cancelQueuedExecution,
  enqueueExecution,
  requeueTransientFailure,
  runJob,
  startExecutionWorker,
  type ExecutionWorkerHandle,
} from "../packages/execution/src/index.js";
import { createWorkspace } from "../packages/workspace/src/index.js";
import { CORRELATION, SYSTEM, unique } from "./helpers.js";

const HANG = JSON.stringify(["node", "-e", "setInterval(() => {}, 1000)"]);
const OK = JSON.stringify(["node", "-e", "process.stdout.write('ok')"]);

/**
 * enqueueExecution is the gate: jobs must name a real workspace, and the
 * `node -e` fixtures below are inline code that only an approval flow may
 * clear — so the fixtures state that explicitly instead of relying on a
 * back door that no longer exists.
 */
async function ws(root: string): Promise<{ workspaceId: string; backendId: string; policyCleared: boolean }> {
  const workspace = await createWorkspace(
    prisma,
    { name: unique("Queue WS"), agentId: null, type: "TEMPORARY" },
    { actor: SYSTEM, correlationId: CORRELATION },
    { root },
  );
  return { workspaceId: workspace.id, backendId: "local", policyCleared: true };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "kw-exec-q-"));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

async function statusOf(id: string): Promise<string | null> {
  const job = await prisma.executionJob.findUnique({ where: { id }, select: { status: true } });
  return job?.status ?? null;
}

function startWorker(options?: { pollIntervalMs?: number; maxConcurrent?: number }): ExecutionWorkerHandle {
  return startExecutionWorker(prisma, { pollIntervalMs: 40, ...options });
}

describe("execution queue + worker", () => {
  it("enqueue validates the command before creating a row", async () => {
    const before = await prisma.executionJob.count();
    await expect(
      enqueueExecution(prisma, { kind: "COMMAND", command: "not json", actor: SYSTEM, correlationId: CORRELATION }),
    ).rejects.toThrow(/JSON/);
    await expect(
      enqueueExecution(prisma, {
        kind: "COMMAND",
        command: JSON.stringify(["node", 42]),
        actor: SYSTEM,
        correlationId: CORRELATION,
      }),
    ).rejects.toThrow(/argv array/);
    expect(await prisma.executionJob.count()).toBe(before);
  });

  it("worker drains queued jobs and stops draining after stop()", async () => {
    const root = tempRoot();
    const worker = startWorker();
    try {
      const job = await enqueueExecution(prisma, {
        kind: "COMMAND",
        command: OK,
        ...(await ws(root)),
        actor: SYSTEM,
        correlationId: CORRELATION,
      });
      expect(job.status).toBe("QUEUED");

      await waitFor(async () => (await statusOf(job.id)) === "COMPLETED");
      expect(await prisma.eventLog.count({ where: { type: "EXECUTION_QUEUED", targetId: job.id } })).toBe(1);
      expect(await prisma.eventLog.count({ where: { type: "EXECUTION_STARTED", targetId: job.id } })).toBe(1);
      expect(await prisma.eventLog.count({ where: { type: "EXECUTION_FINISHED", targetId: job.id } })).toBe(1);

      await worker.stop();

      const after = await enqueueExecution(prisma, {
        kind: "COMMAND",
        command: OK,
        ...(await ws(root)),
        actor: SYSTEM,
        correlationId: CORRELATION,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await statusOf(after.id)).toBe("QUEUED");
      expect(await prisma.eventLog.count({ where: { type: "EXECUTION_STARTED", targetId: after.id } })).toBe(0);
    } finally {
      await worker.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("worker never exceeds its concurrency cap", async () => {
    const root = tempRoot();
    const worker = startWorker({ maxConcurrent: 1 });
    let maxSeen = 0;
    try {
      const jobs = await Promise.all(
        [1, 2, 3].map(async (n) =>
          enqueueExecution(prisma, {
            kind: "COMMAND",
            command: JSON.stringify(["node", "-e", `setTimeout(() => {}, ${500 + n * 100})`]),
            ...(await ws(root)),
            priority: n,
            actor: SYSTEM,
            correlationId: CORRELATION,
          }),
        ),
      );
      await waitFor(async () => {
        maxSeen = Math.max(maxSeen, worker.running());
        const done = await Promise.all(jobs.map((job) => statusOf(job.id)));
        return done.every((status) => status === "COMPLETED");
      });
      maxSeen = Math.max(maxSeen, worker.running());
      expect(maxSeen).toBeLessThanOrEqual(1);
    } finally {
      await worker.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels a queued job before it ever starts", async () => {
    const root = tempRoot();
    const job = await enqueueExecution(prisma, {
      kind: "COMMAND",
      command: HANG,
      ...(await ws(root)),
      actor: SYSTEM,
      correlationId: CORRELATION,
    });

    expect(await cancelQueuedExecution(prisma, job.id, "operator cancelled", { actor: SYSTEM })).toBe("cancelled");
    expect(await statusOf(job.id)).toBe("CANCELLED");
    expect(await prisma.eventLog.count({ where: { type: "EXECUTION_CANCELLED", targetId: job.id } })).toBe(1);

    const worker = startWorker();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await prisma.eventLog.count({ where: { type: "EXECUTION_STARTED", targetId: job.id } })).toBe(0);
      expect(await cancelQueuedExecution(prisma, job.id, "again")).toBe("busy");
      expect(await cancelQueuedExecution(prisma, "cl_missing_job", "nope")).toBe("missing");
    } finally {
      await worker.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requeues transient failures until maxAttempts, then gives up", async () => {
    const root = tempRoot();
    const worker = startWorker();
    try {
      const job = await enqueueExecution(prisma, {
        kind: "COMMAND",
        command: HANG,
        ...(await ws(root)),
        timeoutMs: 400,
        maxAttempts: 2,
        actor: SYSTEM,
        correlationId: CORRELATION,
      });

      await waitFor(
        async () => {
          const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
          return row?.attempts === 2 && row.status === "TIMEOUT";
        },
        15_000,
      );

      const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe("TIMEOUT");
      expect(row?.attempts).toBe(2);
      expect(row?.errorCategory).toBe("TRANSIENT");
      expect(
        await prisma.eventLog.count({ where: { type: "EXECUTION_STARTED", targetId: job.id } }),
      ).toBe(2);
    } finally {
      await worker.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not requeue non-retryable failures", async () => {
    const root = tempRoot();
    try {
      const job = await enqueueExecution(prisma, {
        kind: "COMMAND",
        command: JSON.stringify(["node", "-e", "process.exit(3)"]),
        ...(await ws(root)),
        maxAttempts: 3,
        actor: SYSTEM,
        correlationId: CORRELATION,
      });
      const outcome = await runJob(prisma, job.id);
      expect(outcome).toMatchObject({ claimed: true, status: "FAILED" });

      expect(await requeueTransientFailure(prisma, job.id)).toBe(false);
      const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe("FAILED");
      expect(row?.attempts).toBe(1);
      expect(await requeueTransientFailure(prisma, unique("missing"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stop() is idempotent and awaited jobs survive it", async () => {
    const root = tempRoot();
    const worker = startWorker();
    try {
      const job = await enqueueExecution(prisma, {
        kind: "COMMAND",
        command: OK,
        ...(await ws(root)),
        actor: SYSTEM,
        correlationId: CORRELATION,
      });
      await worker.stop();
      await worker.stop();
      expect(["QUEUED", "COMPLETED"]).toContain(await statusOf(job.id));
    } finally {
      await worker.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
