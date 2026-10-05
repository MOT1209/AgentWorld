import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../packages/database/src/client.js";
import {
  buildOpenCodeArgv,
  createBackend,
  MockExecutionBackend,
  OpenCodeExecutionBackend,
  runJob,
} from "../packages/execution/src/index.js";
import { filterEnv } from "../packages/tools/src/command-policy.js";
import { createWorkspace } from "../packages/workspace/src/index.js";
import { CORRELATION, SYSTEM } from "./helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "kw-exec-be-"));
}

async function makeJob(
  overrides: Partial<{
    kind: string;
    backendId: string;
    command: string | null;
    workingDir: string | null;
    workspaceId: string | null;
    timeoutMs: number;
  }> = {},
): Promise<{ id: string }> {
  return prisma.executionJob.create({
    data: {
      kind: "COMMAND",
      command: JSON.stringify(["node", "-e", "process.stdout.write('done')"]),
      timeoutMs: 30_000,
      correlationId: CORRELATION,
      ...overrides,
    },
  });
}

describe("execution backends", () => {
  it("creates each backend behind one interface", () => {
    expect(createBackend("mock").id).toBe("mock");
    expect(createBackend("local").id).toBe("local");
    expect(createBackend("opencode").id).toBe("opencode");
    expect(() => createBackend("nope")).toThrow(/Unknown execution backend/);
  });

  it("mock backend records calls and replays scripted outcomes", async () => {
    const mock = new MockExecutionBackend([
      { exitCode: 0, stdout: "ok" },
      { exitCode: 1, stderr: "boom" },
    ]);
    expect(await mock.isAvailable()).toBe(true);

    const ok = await mock.run({
      jobId: "job-1",
      kind: "COMMAND",
      workspaceId: null,
      cwd: "",
      argv: ["echo", "hi"],
      env: {},
      timeoutMs: 1000,
      maxBytes: 1024,
    });
    expect(ok.exitCode).toBe(0);

    const failed = await mock.run({
      jobId: "job-2",
      kind: "COMMAND",
      workspaceId: null,
      cwd: "",
      argv: ["false"],
      env: {},
      timeoutMs: 1000,
      maxBytes: 1024,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toBe("boom");
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0]?.argv).toEqual(["echo", "hi"]);
  });

  it("local backend runs argv for real, caps output, and times out", async () => {
    const root = tempRoot();
    try {
      const local = createBackend("local");
      expect(await local.isAvailable()).toBe(true);

      const out = await local.run({
        jobId: "job-local-1",
        kind: "COMMAND",
        workspaceId: null,
        cwd: root,
        argv: ["node", "-e", "process.stdout.write('hi')"],
        env: filterEnv(),
        timeoutMs: 10_000,
        maxBytes: 1024,
      });
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toBe("hi");
      expect(out.timedOut).toBe(false);

      const capped = await local.run({
        jobId: "job-local-2",
        kind: "COMMAND",
        workspaceId: null,
        cwd: root,
        argv: ["node", "-e", "process.stdout.write('x'.repeat(100000))"],
        env: filterEnv(),
        timeoutMs: 10_000,
        maxBytes: 1024,
      });
      expect(capped.truncated).toBe(true);

      const hang = await local.run({
        jobId: "job-local-3",
        kind: "COMMAND",
        workspaceId: null,
        cwd: root,
        argv: ["node", "-e", "setInterval(() => {}, 1000)"],
        env: filterEnv(),
        timeoutMs: 600,
        maxBytes: 1024,
      });
      expect(hang.timedOut).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("local backend refuses to run without an argv", async () => {
    const root = tempRoot();
    try {
      const local = createBackend("local");
      const result = await local.run({
        jobId: "job-local-4",
        kind: "BACKEND",
        workspaceId: null,
        cwd: root,
        env: {},
        timeoutMs: 1000,
        maxBytes: 1024,
      });
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toMatch(/requires an argv/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("opencode backend builds flag-safe argv", () => {
    expect(buildOpenCodeArgv("oc", "do it")).toEqual(["oc", "run", "--format", "json", "--", "do it"]);
    // A prompt can never be parsed as a flag: it always trails `--`.
    expect(buildOpenCodeArgv("oc", "--auto")).toEqual(["oc", "run", "--format", "json", "--", "--auto"]);
    expect(buildOpenCodeArgv("oc", "-m evil/model")).toEqual([
      "oc", "run", "--format", "json", "--", "-m evil/model",
    ]);
  });

  it("opencode backend probes availability and never runs without a prompt", async () => {
    const root = tempRoot();
    try {
      const absent = new OpenCodeExecutionBackend("definitely-not-a-real-opencode-xyz");
      expect(await absent.isAvailable()).toBe(false);
      await expect(
        absent.run({
          jobId: "job-oc-1",
          kind: "BACKEND",
          workspaceId: null,
          cwd: root,
          env: filterEnv(),
          timeoutMs: 1000,
          maxBytes: 1024,
        }),
      ).rejects.toThrow(/prompt/);

      // The configured binary on this machine may or may not exist; probe only —
      // a live end-to-end run is the M6 smoke test, not a unit test.
      const present = new OpenCodeExecutionBackend();
      expect(typeof (await present.isAvailable())).toBe("boolean");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("execution job runner", () => {
  it("claims a queued job, runs it, spools output, and emits events", async () => {
    const root = tempRoot();
    try {
      const workspace = await createWorkspace(
        prisma,
        { name: "Runner Bench", agentId: null, type: "TEMPORARY" },
        { actor: SYSTEM, correlationId: CORRELATION },
        { root },
      );
      const job = await makeJob({ backendId: "local", workspaceId: workspace.id });

      const outcome = await runJob(prisma, job.id);
      expect(outcome).toMatchObject({ claimed: true, status: "COMPLETED", exitCode: 0 });

      const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe("COMPLETED");
      expect(row?.attempts).toBe(1);
      expect(row?.startedAt).not.toBeNull();
      expect(row?.finishedAt).not.toBeNull();
      expect(row?.stdoutBytes).toBe(4);
      expect(row?.error).toBeNull();

      const result = JSON.parse(row?.result ?? "{}") as { stdoutPath: string | null; timedOut: boolean };
      expect(result.timedOut).toBe(false);
      expect(result.stdoutPath).toContain(".agentworld");
      expect(readFileSync(result.stdoutPath as string, "utf8")).toBe("done");

      const started = await prisma.eventLog.count({
        where: { type: "EXECUTION_STARTED", targetId: job.id },
      });
      const finished = await prisma.eventLog.count({
        where: { type: "EXECUTION_FINISHED", targetId: job.id },
      });
      expect(started).toBe(1);
      expect(finished).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never re-runs a job that is no longer queued", async () => {
    const job = await makeJob({ backendId: "mock" });
    const first = await runJob(prisma, job.id);
    expect(first).toMatchObject({ claimed: true, status: "COMPLETED" });

    const second = await runJob(prisma, job.id);
    expect(second.claimed).toBe(false);
    expect(second.status).toBeUndefined();
  });

  it("marks a nonzero exit FAILED with the exit code in the error", async () => {
    const root = tempRoot();
    try {
      const job = await makeJob({
        backendId: "local",
        workingDir: root,
        command: JSON.stringify(["node", "-e", "process.exit(2)"]),
      });
      const outcome = await runJob(prisma, job.id);
      expect(outcome).toMatchObject({ claimed: true, status: "FAILED", exitCode: 2 });

      const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe("FAILED");
      expect(row?.error).toBe("Exited with code 2");
      expect(row?.finishedAt).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a timeout TIMEOUT with a transient category", async () => {
    const root = tempRoot();
    try {
      const job = await makeJob({
        backendId: "local",
        workingDir: root,
        command: JSON.stringify(["node", "-e", "setInterval(() => {}, 1000)"]),
        timeoutMs: 600,
      });
      const outcome = await runJob(prisma, job.id);
      expect(outcome).toMatchObject({ claimed: true, status: "TIMEOUT" });

      const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
      expect(row?.status).toBe("TIMEOUT");
      expect(row?.errorCategory).toBe("TRANSIENT");
      expect(row?.error).toMatch(/Timed out/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails process jobs that have no working directory (configuration)", async () => {
    const job = await makeJob({ backendId: "local", workingDir: null, workspaceId: null });
    const outcome = await runJob(prisma, job.id);
    expect(outcome).toMatchObject({ claimed: true, status: "FAILED" });

    const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
    expect(row?.errorCategory).toBe("CONFIGURATION");
    expect(row?.error).toMatch(/working directory/);
  });

  it("runs a mock backend job without any working directory", async () => {
    const job = await makeJob({ backendId: "mock", workingDir: null, workspaceId: null });
    const outcome = await runJob(prisma, job.id);
    expect(outcome).toMatchObject({ claimed: true, status: "COMPLETED" });

    const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
    const result = JSON.parse(row?.result ?? "{}") as { stdoutPath: string | null };
    expect(result.stdoutPath).not.toBeNull();
    unlinkSync(result.stdoutPath as string);
    unlinkSync((result.stdoutPath as string).replace(".stdout.log", ".stderr.log"));
  });

  it("fails a job with an unknown backend id as configuration", async () => {
    const job = await makeJob({ backendId: "nope" });
    const outcome = await runJob(prisma, job.id);
    expect(outcome).toMatchObject({ claimed: true, status: "FAILED" });

    const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
    expect(row?.errorCategory).toBe("CONFIGURATION");
    expect(row?.error).toMatch(/Unknown execution backend/);
  });

  it("fails a job whose command row is corrupt", async () => {
    const job = await makeJob({ backendId: "mock", command: "not json at all" });
    const outcome = await runJob(prisma, job.id);
    expect(outcome).toMatchObject({ claimed: true, status: "FAILED" });

    const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
    expect(row?.errorCategory).toBe("CONFIGURATION");
    expect(row?.error).toMatch(/JSON/);
  });

  it("throws for a job id that does not exist", async () => {
    await expect(runJob(prisma, "cl_does_not_exist")).rejects.toThrow(/not found/);
  });
});
