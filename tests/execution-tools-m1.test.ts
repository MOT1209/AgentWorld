import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../packages/database/src/client.js";
import { createDefaultRegistry, ToolExecutor } from "../packages/tools/src/index.js";
import { terminalProcesses } from "../packages/tools/src/process-manager.js";
import { createWorkspace, resolveInRoot } from "../packages/workspace/src/index.js";
import { enqueueExecution, runJob } from "../packages/execution/src/index.js";
import type { Permission } from "../packages/security/src/permissions.js";
import { SYSTEM, CORRELATION, createTestAgent } from "./helpers.js";

const PERMS: Permission[] = ["workspace.read", "workspace.write", "workspace.execute"];

function executorFor(agentId: string) {
  return {
    executor: new ToolExecutor({ registry: createDefaultRegistry() }),
    ctx: {
      agentId,
      actor: { actorType: "AGENT" as const, actorId: agentId },
      correlationId: CORRELATION,
      permissions: new Set(PERMS),
      db: prisma,
      now: new Date(),
    },
  };
}

async function workspaceFor(agentId: string, root: string, environment?: Record<string, unknown>) {
  return createWorkspace(
    prisma,
    { name: "M1 Bench", agentId, type: "TEMPORARY", ...(environment !== undefined ? { environment } : {}) },
    { actor: SYSTEM, correlationId: CORRELATION },
    { root },
  );
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "kw-m1-"));
}

type ExecData = { job: { id: string; status: string; backendId: string | null } };

describe("execution.* tools (real ToolExecutor)", () => {
  it("queues a command without running it inline, then reads it back", async () => {
    const agent = await createTestAgent({ name: "Exec Creator" });
    const root = tempRoot();
    try {
      const workspace = await workspaceFor(agent.id, root);
      writeFileSync(join(workspace.path, "task.js"), "process.stdout.write('ran')", "utf8");
      const { executor, ctx } = executorFor(agent.id);

      const created = await executor.invoke(
        "execution.create",
        { workspaceId: workspace.id, command: ["node", "task.js"] },
        ctx,
      );
      expect(created.status).toBe("SUCCESS");
      const job = (created.data as ExecData).job;
      expect(job.status).toBe("QUEUED"); // never executed in the request path
      expect(job.backendId).toBe("local");

      const got = await executor.invoke("execution.get", { executionId: job.id }, ctx);
      expect(got.status).toBe("SUCCESS");
      expect((got.data as ExecData).job.id).toBe(job.id);

      const listed = await executor.invoke("execution.list", { workspaceId: workspace.id }, ctx);
      expect((listed.data as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).toContain(job.id);

      // The row carries the agent as creator so ownership checks have something to hold.
      const row = await prisma.executionJob.findUnique({ where: { id: job.id } });
      expect(row?.agentId).toBe(agent.id);

      await runJob(prisma, job.id);
      const done = await executor.invoke("execution.get", { executionId: job.id }, ctx);
      expect((done.data as ExecData).job.status).toBe("COMPLETED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses destruction and holds unvetted commands and prompt runs for approval", async () => {
    const agent = await createTestAgent({ name: "Exec Policy" });
    const root = tempRoot();
    try {
      const workspace = await workspaceFor(agent.id, root);
      const { executor, ctx } = executorFor(agent.id);
      const before = await prisma.executionJob.count({ where: { workspaceId: workspace.id } });

      const denied = await executor.invoke(
        "execution.create",
        { workspaceId: workspace.id, command: ["rm", "-rf", "/"] },
        ctx,
      );
      expect(denied.status).toBe("ERROR");

      const unknown = await executor.invoke(
        "execution.create",
        { workspaceId: workspace.id, command: ["curl", "http://127.0.0.1:1/"] },
        ctx,
      );
      expect(unknown.status).toBe("PENDING_APPROVAL");

      const inline = await executor.invoke(
        "execution.create",
        { workspaceId: workspace.id, command: ["node", "-e", "1"] },
        ctx,
      );
      expect(inline.status).toBe("PENDING_APPROVAL");

      const prompt = await executor.invoke(
        "execution.create",
        { workspaceId: workspace.id, command: { prompt: "build me a thing" } },
        ctx,
      );
      expect(prompt.status).toBe("PENDING_APPROVAL");

      // None of the refused/held calls created a job row.
      expect(await prisma.executionJob.count({ where: { workspaceId: workspace.id } })).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolates workspaces: another agent cannot create, read, list or cancel", async () => {
    const owner = await createTestAgent({ name: "Exec Owner" });
    const intruder = await createTestAgent({ name: "Exec Intruder" });
    const root = tempRoot();
    try {
      const workspace = await workspaceFor(owner.id, root);
      const job = await enqueueExecution(prisma, {
        kind: "COMMAND",
        command: JSON.stringify(["node", "--version"]),
        actor: SYSTEM,
        correlationId: CORRELATION,
        backendId: "local",
        workspaceId: workspace.id,
        agentId: owner.id,
      });
      const { executor, ctx } = executorFor(intruder.id);

      const create = await executor.invoke(
        "execution.create",
        { workspaceId: workspace.id, command: ["node", "--version"] },
        ctx,
      );
      expect(create.status).toBe("ERROR");

      const get = await executor.invoke("execution.get", { executionId: job.id }, ctx);
      expect(get.status).toBe("ERROR");

      const list = await executor.invoke("execution.list", { workspaceId: workspace.id }, ctx);
      expect(list.status).toBe("ERROR");

      const cancel = await executor.invoke("execution.cancel", { executionId: job.id }, ctx);
      expect(cancel.status).toBe("ERROR");
      expect((await prisma.executionJob.findUnique({ where: { id: job.id } }))?.status).toBe("QUEUED");

      // Unfiltered list never leaks the owner's job to the intruder.
      const unfiltered = await executor.invoke("execution.list", {}, ctx);
      expect(unfiltered.status).toBe("SUCCESS");
      expect((unfiltered.data as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).not.toContain(job.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels a queued job, and refuses once it is no longer queued", async () => {
    const agent = await createTestAgent({ name: "Exec Canceller" });
    const root = tempRoot();
    try {
      const workspace = await workspaceFor(agent.id, root);
      writeFileSync(join(workspace.path, "noop.js"), "", "utf8");
      const { executor, ctx } = executorFor(agent.id);
      const created = await executor.invoke(
        "execution.create",
        { workspaceId: workspace.id, command: ["node", "noop.js"] },
        ctx,
      );
      const id = (created.data as ExecData).job.id;

      const cancelled = await executor.invoke("execution.cancel", { executionId: id }, ctx);
      expect(cancelled.status).toBe("SUCCESS");
      expect((await prisma.executionJob.findUnique({ where: { id } }))?.status).toBe("CANCELLED");

      const again = await executor.invoke("execution.cancel", { executionId: id }, ctx);
      expect(again.status).toBe("ERROR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels a RUNNING job by signalling the live child", async () => {
    const agent = await createTestAgent({ name: "Exec Stopper" });
    const root = tempRoot();
    try {
      const workspace = await workspaceFor(agent.id, root);
      writeFileSync(join(workspace.path, "hang.js"), "setInterval(() => {}, 1000)", "utf8");
      const { executor, ctx } = executorFor(agent.id);
      const created = await executor.invoke(
        "execution.create",
        { workspaceId: workspace.id, command: ["node", "hang.js"] },
        ctx,
      );
      const id = (created.data as ExecData).job.id;

      const running = runJob(prisma, id);
      for (let waited = 0; waited < 8_000; waited += 25) {
        if ((await prisma.executionJob.findUnique({ where: { id } }))?.status === "RUNNING") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect((await prisma.executionJob.findUnique({ where: { id } }))?.status).toBe("RUNNING");

      const stopped = await executor.invoke(
        "execution.cancel",
        { executionId: id, reason: "stop now" },
        ctx,
      );
      expect(stopped.status).toBe("SUCCESS");
      expect((stopped.data as { cancelled: boolean; stopping: boolean })).toMatchObject({
        cancelled: true,
        stopping: true,
      });

      expect(await running).toMatchObject({ claimed: true, status: "CANCELLED" });
      const row = await prisma.executionJob.findUnique({ where: { id } });
      expect(row?.status).toBe("CANCELLED");
      expect(row?.error).toBe("stop now");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("enqueue gate (single creation path)", () => {
  it("rejects escaped working directories, missing workspaces and denied commands", async () => {
    const agent = await createTestAgent({ name: "Gate Agent" });
    const root = tempRoot();
    try {
      const workspace = await workspaceFor(agent.id, root);
      const base = {
        kind: "COMMAND" as const,
        actor: SYSTEM,
        correlationId: CORRELATION,
        backendId: "local",
        workspaceId: workspace.id,
      };
      const argv = JSON.stringify(["node", "--version"]);
      for (const workingDir of ["..", "../..", "sub/../../x", tmpdir(), root, "C:\\Windows", "\\\\server\\share"]) {
        await expect(enqueueExecution(prisma, { ...base, command: argv, workingDir })).rejects.toThrow();
      }
      await expect(
        enqueueExecution(prisma, { ...base, command: JSON.stringify(["rm", "-rf", "/"]) }),
      ).rejects.toThrow(/never allowed/);
      await expect(
        enqueueExecution(prisma, { ...base, command: JSON.stringify(["curl", "x"]) }),
      ).rejects.toThrow(/approval/);
      await expect(
        enqueueExecution(prisma, { ...base, workspaceId: "cl_missing", command: argv }),
      ).rejects.toThrow(/Workspace not found/);
      await expect(
        enqueueExecution(prisma, { ...base, workspaceId: null, command: argv }),
      ).rejects.toThrow(/require a workspace/);

      // An in-bounds subdirectory is accepted and stored as a validated absolute path.
      mkdirSync(join(workspace.path, "sub"), { recursive: true });
      const ok = await enqueueExecution(prisma, { ...base, command: argv, workingDir: "sub" });
      expect(ok.workingDir).toBe(join(workspace.path, "sub"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the runner refuses a denied command even if a row was written around the gate", async () => {
    const agent = await createTestAgent({ name: "Runner Gate" });
    const root = tempRoot();
    try {
      const workspace = await workspaceFor(agent.id, root);
      const row = await prisma.executionJob.create({
        data: {
          kind: "COMMAND",
          backendId: "local",
          workspaceId: workspace.id,
          command: JSON.stringify(["rm", "-rf", "/"]),
          correlationId: CORRELATION,
        },
      });
      const outcome = await runJob(prisma, row.id);
      expect(outcome).toMatchObject({ claimed: true, status: "FAILED" });
      const after = await prisma.executionJob.findUnique({ where: { id: row.id } });
      expect(after?.error).toMatch(/never allowed/);

      const escaped = await prisma.executionJob.create({
        data: {
          kind: "COMMAND",
          backendId: "local",
          workspaceId: workspace.id,
          workingDir: tmpdir(),
          command: JSON.stringify(["node", "--version"]),
          correlationId: CORRELATION,
        },
      });
      expect(await runJob(prisma, escaped.id)).toMatchObject({ claimed: true, status: "FAILED" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("terminal.status and ownership", () => {
  it("reports live executions and hides them from other agents", async () => {
    const owner = await createTestAgent({ name: "Term Status Owner" });
    const other = await createTestAgent({ name: "Term Status Other" });
    const root = tempRoot();
    try {
      const workspace = await workspaceFor(owner.id, root);
      writeFileSync(join(workspace.path, "spin.js"), "setInterval(() => {}, 1000)", "utf8");
      const { executor, ctx } = executorFor(owner.id);
      const outsider = executorFor(other.id);

      const running = executor.invoke(
        "terminal.exec",
        { workspaceId: workspace.id, argv: ["node", "spin.js"], timeoutMs: 3000 },
        ctx,
      );
      let liveId: string | undefined;
      for (let i = 0; i < 100 && liveId === undefined; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        liveId = terminalProcesses.liveInWorkspace(workspace.id)[0];
      }
      expect(liveId).toBeDefined();

      const status = await executor.invoke("terminal.status", { executionId: liveId }, ctx);
      expect(status.status).toBe("SUCCESS");
      expect((status.data as { running: boolean }).running).toBe(true);

      // Another agent can neither see nor kill it, and gets the same answer as for an unknown id.
      const peek = await outsider.executor.invoke("terminal.status", { executionId: liveId }, outsider.ctx);
      expect(peek.status).toBe("ERROR");
      const kill = await outsider.executor.invoke("terminal.kill", { executionId: liveId }, outsider.ctx);
      expect(kill.status).toBe("ERROR");
      expect(terminalProcesses.status(liveId as string)).not.toBeNull();

      const stopped = await executor.invoke("terminal.kill", { executionId: liveId }, ctx);
      expect(stopped.status).toBe("SUCCESS");
      await running;
      expect(terminalProcesses.liveCount).toBe(0);

      const gone = await executor.invoke("terminal.status", { executionId: liveId }, ctx);
      expect(gone.status).toBe("ERROR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("git.add", () => {
  it("stages only workspace paths and refuses escapes and option smuggling", async () => {
    const agent = await createTestAgent({ name: "Git Add" });
    const root = tempRoot();
    try {
      const workspace = await workspaceFor(agent.id, root);
      const { executor, ctx } = executorFor(agent.id);
      const init = await executor.invoke(
        "terminal.exec",
        { workspaceId: workspace.id, argv: ["git", "init", "-q"] },
        ctx,
      );
      expect((init.data as { exitCode: number }).exitCode).toBe(0);
      writeFileSync(join(workspace.path, "a.txt"), "a", "utf8");
      writeFileSync(join(workspace.path, "b.txt"), "b", "utf8");

      const added = await executor.invoke("git.add", { workspaceId: workspace.id, paths: ["a.txt"] }, ctx);
      expect(added.status).toBe("SUCCESS");
      const status = await executor.invoke("git.status", { workspaceId: workspace.id }, ctx);
      const files = (status.data as { files: string[] }).files;
      expect(files.some((line) => line.startsWith("A") && line.includes("a.txt"))).toBe(true);
      expect(files.some((line) => line.startsWith("?") && line.includes("b.txt"))).toBe(true);

      for (const path of ["../outside.txt", "..", "/etc/passwd", "C:\\Windows\\win.ini", "sub/../../x"]) {
        const result = await executor.invoke("git.add", { workspaceId: workspace.id, paths: [path] }, ctx);
        expect(result.status).toBe("ERROR");
      }
      // An option-looking name is just a (missing) file, never a flag.
      const flag = await executor.invoke("git.add", { workspaceId: workspace.id, paths: ["--all"] }, ctx);
      const afterFlag = await executor.invoke("git.status", { workspaceId: workspace.id }, ctx);
      expect(flag.status).toBe("ERROR");
      expect((afterFlag.data as { files: string[] }).files.some((l) => l.includes("b.txt") && l.startsWith("?"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("path guard: not-yet-existing paths under a symlinked directory", () => {
  it("rejects a new file below a symlink that points outside the root", () => {
    const base = mkdtempSync(join(tmpdir(), "kw-sym-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    try {
      let linked = true;
      try {
        symlinkSync(outside, join(root, "link"), "junction");
      } catch {
        linked = false; // symlink creation can be privileged on some hosts
      }
      if (!linked) return;
      expect(() => resolveInRoot(root, "link", "new-file.txt")).toThrow(/outside the workspace root/);
      expect(() => resolveInRoot(root, "link", "deep", "new.txt")).toThrow(/outside the workspace root/);
      // A plain missing path inside the root is still fine.
      expect(resolveInRoot(root, "fresh", "file.txt").startsWith(root)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
