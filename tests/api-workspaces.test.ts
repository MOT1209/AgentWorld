import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import { runJob } from "../packages/execution/src/index.js";
import { createWorkspace } from "../packages/workspace/src/index.js";
import { CORRELATION, SYSTEM, unique } from "./helpers.js";

const app = createApp();

async function createToken(role: "OWNER" | "OBSERVER"): Promise<string> {
  const email = `${unique("execapi")}${role}@test.local`.toLowerCase();
  await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword("TestPassword123", 10),
      displayName: role,
      role,
      isActive: true,
    },
  });
  const login = await request(app).post("/api/v1/auth/login").send({ email, password: "TestPassword123" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "kw-exec-api-"));
}

async function makeWorkspace(root: string, scripts: Record<string, string> = {}) {
  const workspace = await createWorkspace(
    prisma,
    { name: unique("Exec API WS"), agentId: null, type: "TEMPORARY" },
    { actor: SYSTEM, correlationId: CORRELATION },
    { root },
  );
  for (const [name, source] of Object.entries(scripts)) {
    writeFileSync(join(workspace.path, name), source, "utf8");
  }
  return workspace;
}

describe("executions REST", () => {
  it("enqueues, lists, runs, and streams output", async () => {
    const root = tempRoot();
    try {
      const token = await createToken("OWNER");
      const auth = { Authorization: `Bearer ${token}` };

      const anon = await request(app).get("/api/v1/executions");
      expect(anon.status).toBe(401);

      const workspace = await makeWorkspace(root, { "hello.js": "process.stdout.write('done')" });
      const enqueue = await request(app)
        .post("/api/v1/executions")
        .set(auth)
        .send({ kind: "COMMAND", command: ["node", "hello.js"], workspaceId: workspace.id });
      expect(enqueue.status).toBe(201);
      const job = enqueue.body.data.job as { id: string; status: string; command: string };
      expect(job.status).toBe("QUEUED");
      expect(JSON.parse(job.command)).toEqual(["node", "hello.js"]);

      const list = await request(app).get("/api/v1/executions?status=QUEUED").set(auth);
      expect(list.status).toBe(200);
      expect((list.body.data.items as Array<{ id: string }>).some((item) => item.id === job.id)).toBe(true);

      const beforeRun = await request(app).get(`/api/v1/executions/${job.id}/output`).set(auth);
      expect(beforeRun.status).toBe(409);

      const outcome = await runJob(prisma, job.id);
      expect(outcome).toMatchObject({ claimed: true, status: "COMPLETED" });

      const detail = await request(app).get(`/api/v1/executions/${job.id}`).set(auth);
      expect(detail.status).toBe(200);
      expect(detail.body.data.job.status).toBe("COMPLETED");

      const output = await request(app).get(`/api/v1/executions/${job.id}/output`).set(auth);
      expect(output.status).toBe(200);
      expect(output.body.data.stdout).toBe("done");
      expect(output.body.data.stdoutTruncated).toBe(false);
      expect(output.body.data.stderr).toBe("");

      const missing = await request(app).get("/api/v1/executions/cl_does_not_exist").set(auth);
      expect(missing.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates the command shape for each kind", async () => {
    const token = await createToken("OWNER");
    const auth = { Authorization: `Bearer ${token}` };

    const promptAsCommand = await request(app)
      .post("/api/v1/executions")
      .set(auth)
      .send({ kind: "COMMAND", command: { prompt: "hi" }, workingDir: tempRoot() });
    expect(promptAsCommand.status).toBe(400);

    const argvAsPrompt = await request(app)
      .post("/api/v1/executions")
      .set(auth)
      .send({ kind: "BACKEND", command: ["node", "-e", "1"] });
    expect(argvAsPrompt.status).toBe(400);

    const shellString = await request(app)
      .post("/api/v1/executions")
      .set(auth)
      .send({ kind: "COMMAND", command: "rm -rf /" });
    expect(shellString.status).toBe(400);
  });

  it("cancels a RUNNING job with 202 and settles it as CANCELLED", async () => {
    const root = tempRoot();
    try {
      const auth = { Authorization: `Bearer ${await createToken("OWNER")}` };

      const workspace = await makeWorkspace(root, { "hang.js": "setInterval(() => {}, 1000)" });
      const enqueue = await request(app)
        .post("/api/v1/executions")
        .set(auth)
        .send({ kind: "COMMAND", command: ["node", "hang.js"], workspaceId: workspace.id });
      expect(enqueue.status).toBe(201);
      const jobId = enqueue.body.data.job.id as string;

      const running = runJob(prisma, jobId);
      for (let waited = 0; waited < 8_000; waited += 25) {
        const row = await prisma.executionJob.findUnique({ where: { id: jobId } });
        if (row?.status === "RUNNING") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect((await prisma.executionJob.findUnique({ where: { id: jobId } }))?.status).toBe("RUNNING");

      const stop = await request(app).post(`/api/v1/executions/${jobId}/cancel`).set(auth);
      expect(stop.status).toBe(202);
      expect(stop.body.data).toMatchObject({ cancelled: true, stopping: true });

      expect(await running).toMatchObject({ claimed: true, status: "CANCELLED" });
      expect((await prisma.executionJob.findUnique({ where: { id: jobId } }))?.status).toBe("CANCELLED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces execute permission and cancels queued jobs", async () => {
    const root = tempRoot();
    try {
      const ownerAuth = { Authorization: `Bearer ${await createToken("OWNER")}` };
      const observerAuth = { Authorization: `Bearer ${await createToken("OBSERVER")}` };

      const observerList = await request(app).get("/api/v1/executions").set(observerAuth);
      expect(observerList.status).toBe(200);

      const workspace = await makeWorkspace(root, { "hang.js": "setInterval(() => {}, 1000)" });
      const observerEnqueue = await request(app)
        .post("/api/v1/executions")
        .set(observerAuth)
        .send({ kind: "COMMAND", command: ["node", "hang.js"], workspaceId: workspace.id });
      expect(observerEnqueue.status).toBe(403);

      const enqueue = await request(app)
        .post("/api/v1/executions")
        .set(ownerAuth)
        .send({ kind: "COMMAND", command: ["node", "hang.js"], workspaceId: workspace.id });
      expect(enqueue.status).toBe(201);
      const jobId = enqueue.body.data.job.id as string;

      const cancelled = await request(app).post(`/api/v1/executions/${jobId}/cancel`).set(ownerAuth);
      expect(cancelled.status).toBe(200);

      const row = await prisma.executionJob.findUnique({ where: { id: jobId } });
      expect(row?.status).toBe("CANCELLED");

      const again = await request(app).post(`/api/v1/executions/${jobId}/cancel`).set(ownerAuth);
      expect(again.status).toBe(409);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses commands and directories the policy gate must stop", async () => {
    const root = tempRoot();
    try {
      const auth = { Authorization: `Bearer ${await createToken("OWNER")}` };
      const workspace = await makeWorkspace(root);
      const before = await prisma.executionJob.count();
      const post = (body: Record<string, unknown>) =>
        request(app).post("/api/v1/executions").set(auth).send({ kind: "COMMAND", workspaceId: workspace.id, ...body });

      // Destructive: never runs, never approvable.
      expect((await post({ command: ["rm", "-rf", "/"] })).status).toBe(403);
      // Inline code and unknown binaries need the approval flow, which REST cannot clear.
      expect((await post({ command: ["node", "-e", "1"] })).status).toBe(403);
      expect((await post({ command: ["curl", "https://example.com"] })).status).toBe(403);
      // Working directory must stay inside the workspace (relative, absolute, encoded forms).
      expect((await post({ command: ["node", "--version"], workingDir: ".." })).status).toBe(400);
      expect((await post({ command: ["node", "--version"], workingDir: root })).status).toBe(400);
      expect((await post({ command: ["node", "--version"], workingDir: tmpdir() })).status).toBe(400);
      // Local backend without a workspace has no ambient directory to fall back on.
      const noWorkspace = await request(app)
        .post("/api/v1/executions")
        .set(auth)
        .send({ kind: "COMMAND", command: ["node", "--version"], backendId: "local" });
      expect(noWorkspace.status).toBe(400);

      expect(await prisma.executionJob.count()).toBe(before);

      // The in-bounds case still works.
      const ok = await post({ command: ["node", "--version"] });
      expect(ok.status).toBe(201);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to serve output paths that are not this job's spool files", async () => {
    const root = tempRoot();
    try {
      const token = await createToken("OWNER");
      const auth = { Authorization: `Bearer ${token}` };
      const outside = join(root, "secret.txt");
      writeFileSync(outside, "not execution output", "utf8");

      const workspace = await makeWorkspace(root, { "noop.js": "" });
      const enqueue = await request(app)
        .post("/api/v1/executions")
        .set(auth)
        .send({ kind: "COMMAND", command: ["node", "noop.js"], workspaceId: workspace.id });
      const jobId = enqueue.body.data.job.id as string;
      await runJob(prisma, jobId);

      await prisma.executionJob.update({
        where: { id: jobId },
        data: { result: JSON.stringify({ stdoutPath: outside, stderrPath: outside }) },
      });
      const tampered = await request(app).get(`/api/v1/executions/${jobId}/output`).set(auth);
      expect(tampered.status).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("workspaces files REST", () => {
  it("browses a workspace one level at a time behind the path guard", async () => {
    const root = tempRoot();
    try {
      const token = await createToken("OWNER");
      const auth = { Authorization: `Bearer ${token}` };
      const workspace = await createWorkspace(
        prisma,
        { name: unique("Files WS"), agentId: null, type: "TEMPORARY" },
        { actor: SYSTEM, correlationId: CORRELATION },
        { root },
      );
      writeFileSync(join(workspace.path, "hello.txt"), "hi", "utf8");

      const listed = await request(app).get(`/api/v1/workspaces/${workspace.id}/files`).set(auth);
      expect(listed.status).toBe(200);
      const files = listed.body.data.files as { path: string; parent: string | null; entries: Array<{ name: string; type: string }> };
      expect(files.path).toBe("");
      expect(files.parent).toBeNull();
      expect(files.entries.some((entry) => entry.name === "hello.txt" && entry.type === "FILE")).toBe(true);

      const missing = await request(app).get(`/api/v1/workspaces/${workspace.id}/files?path=nope`).set(auth);
      expect(missing.status).toBe(404);

      const escape = await request(app)
        .get(`/api/v1/workspaces/${workspace.id}/files?path=${encodeURIComponent("..")}`)
        .set(auth);
      expect(escape.status).toBe(400);

      const missingWorkspace = await request(app)
        .get("/api/v1/workspaces/cl_does_not_exist/files")
        .set(auth);
      expect(missingWorkspace.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
