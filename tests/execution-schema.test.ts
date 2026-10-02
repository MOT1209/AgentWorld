import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../packages/database/src/client.js";
import { createWorkspace, type WorkspaceActorContext } from "../packages/workspace/src/index.js";
import { SessionStatusSchema } from "../packages/shared/src/enums.js";
import { EVENT_TYPES } from "../packages/events/src/catalog.js";
import { SYSTEM, CORRELATION, createTestAgent, unique } from "./helpers.js";

const SYSTEM_CTX: WorkspaceActorContext = { actor: SYSTEM, correlationId: CORRELATION };

describe("execution schema (M2b)", () => {
  it("rebuilds AgentSession with workspaceId/backendId and round-trips them", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentworld-exec-"));
    try {
      const agent = await createTestAgent();
      const ws = await createWorkspace(
        prisma,
        { name: unique("Exec"), agentId: agent.id },
        SYSTEM_CTX,
        { root },
      );

      const session = await prisma.agentSession.create({
        data: {
          agentId: agent.id,
          providerId: "mock",
          model: "mock-1",
          status: "QUEUED",
          workspaceId: ws.id,
          backendId: "mock",
        },
      });
      expect(session.workspaceId).toBe(ws.id);
      expect(session.backendId).toBe("mock");

      const loaded = await prisma.agentSession.findUniqueOrThrow({
        where: { id: session.id },
        include: { workspace: true },
      });
      expect(loaded.workspace?.id).toBe(ws.id);

      // Legacy sessions survive the rebuild with null execution columns.
      const legacy = await prisma.agentSession.create({
        data: { agentId: agent.id, providerId: "mock", model: "mock-1" },
      });
      expect(legacy.workspaceId).toBeNull();
      expect(legacy.backendId).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates an ExecutionJob with safe defaults and walks QUEUED -> COMPLETED", async () => {
    const agent = await createTestAgent();
    const session = await prisma.agentSession.create({
      data: { agentId: agent.id, providerId: "mock", model: "mock-1" },
    });

    const job = await prisma.executionJob.create({
      data: {
        kind: "COMMAND",
        command: JSON.stringify(["node", "-e", "process.exit(0)"]),
        agentId: agent.id,
        sessionId: session.id,
        createdBy: agent.id,
        correlationId: CORRELATION,
      },
    });
    expect(job.status).toBe("QUEUED");
    expect(job.priority).toBe(0);
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(1);
    expect(job.timeoutMs).toBe(600_000);
    expect(job.stdoutBytes).toBe(0);

    const started = await prisma.executionJob.update({
      where: { id: job.id },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    expect(started.status).toBe("RUNNING");

    const done = await prisma.executionJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        exitCode: 0,
        result: JSON.stringify({ exitCode: 0, durationMs: 5 }),
      },
    });
    expect(done.exitCode).toBe(0);

    // The queue's claim query: pending work ordered by priority/schedule.
    const pending = await prisma.executionJob.findMany({
      where: { status: "QUEUED" },
      orderBy: [{ priority: "desc" }, { scheduledAt: "asc" }],
      take: 5,
    });
    expect(pending.every((j) => j.status === "QUEUED")).toBe(true);
  });

  it("registers an Artifact against workspace, session and execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentworld-art-"));
    try {
      const agent = await createTestAgent();
      const ws = await createWorkspace(
        prisma,
        { name: unique("Art"), agentId: agent.id },
        SYSTEM_CTX,
        { root },
      );
      const session = await prisma.agentSession.create({
        data: {
          agentId: agent.id,
          providerId: "mock",
          model: "mock-1",
          workspaceId: ws.id,
          backendId: "mock",
        },
      });
      const job = await prisma.executionJob.create({
        data: {
          kind: "COMMAND",
          command: JSON.stringify(["echo", "hi"]),
          workspaceId: ws.id,
          sessionId: session.id,
          agentId: agent.id,
        },
      });

      const artifact = await prisma.artifact.create({
        data: {
          name: "output.log",
          kind: "LOG",
          path: "logs/output.log",
          sizeBytes: 12,
          mimeType: "text/plain",
          workspaceId: ws.id,
          sessionId: session.id,
          agentId: agent.id,
          executionId: job.id,
        },
        include: { workspace: true, execution: true },
      });
      expect(artifact.status).toBe("READY");
      expect(artifact.path).toBe("logs/output.log");
      expect(artifact.workspace?.id).toBe(ws.id);
      expect(artifact.execution?.id).toBe(job.id);

      // Deleting the job detaches the artifact instead of cascading it away.
      await prisma.executionJob.delete({ where: { id: job.id } });
      const orphan = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
      expect(orphan.executionId).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the additive session statuses and publishes execution events", () => {
    expect(SessionStatusSchema.parse("QUEUED")).toBe("QUEUED");
    expect(SessionStatusSchema.parse("TIMEOUT")).toBe("TIMEOUT");
    expect(SessionStatusSchema.parse("RUNNING")).toBe("RUNNING");

    const events = [
      "EXECUTION_QUEUED",
      "EXECUTION_STARTED",
      "EXECUTION_FINISHED",
      "EXECUTION_CANCELLED",
      "PROCESS_KILLED",
      "ARTIFACT_CREATED",
    ];
    for (const e of events) {
      expect(EVENT_TYPES).toHaveProperty(e);
    }
  });
});
