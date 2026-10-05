import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import { enqueueExecution, runJob } from "../packages/execution/src/index.js";
import { createWorkspace, registerArtifact, resolveInRoot } from "../packages/workspace/src/index.js";
import { filterEnv } from "../packages/tools/src/command-policy.js";
import { CORRELATION, SYSTEM, unique } from "./helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "kw-sec-"));
}

async function workspace(root: string, scripts: Record<string, string> = {}) {
  const ws = await createWorkspace(
    prisma,
    { name: unique("Sec WS"), agentId: null, type: "TEMPORARY" },
    { actor: SYSTEM, correlationId: CORRELATION },
    { root },
  );
  for (const [name, source] of Object.entries(scripts)) writeFileSync(join(ws.path, name), source, "utf8");
  return ws;
}

describe("path guard attack matrix", () => {
  it("rejects traversal, absolute, drive and UNC forms", () => {
    const root = tempRoot();
    try {
      for (const attack of [
        "..",
        "../",
        "../..",
        "..\\..",
        "a/../../b",
        "a\\..\\..\\b",
        "C:\\Windows\\win.ini",
        "C:/Windows/win.ini",
        "\\\\server\\share\\x",
        "//server/share/x",
        "/etc/passwd",
      ]) {
        expect(() => resolveInRoot(root, attack), attack).toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats percent-encoded dots as literal names, never as traversal", () => {
    const root = tempRoot();
    try {
      const inside = resolveInRoot(root, "%2e%2e", "secret");
      expect(inside.startsWith(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks nested symlink chains that end outside the root", () => {
    const base = mkdtempSync(join(tmpdir(), "kw-chain-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "top secret", "utf8");
    try {
      try {
        symlinkSync(outside, join(root, "b"), "junction");
        symlinkSync(join(root, "b"), join(root, "a"), "junction");
      } catch {
        return; // symlink creation is privileged on some hosts
      }
      expect(() => resolveInRoot(root, "a", "secret.txt")).toThrow(/outside the workspace root/);
      expect(() => resolveInRoot(root, "a", "new.txt")).toThrow(/outside the workspace root/);
      expect(() => resolveInRoot(root, "b")).toThrow(/outside the workspace root/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("artifacts cannot leave their workspace", () => {
  it("refuses paths outside the root and directories, and is idempotent", async () => {
    const root = tempRoot();
    try {
      const ws = await workspace(root, { "out.txt": "result" });
      for (const path of ["../outside.txt", "..", "C:\\Windows\\win.ini", "/etc/passwd", "."]) {
        await expect(registerArtifact(prisma, { workspaceId: ws.id, path }), path).rejects.toThrow();
      }
      mkdirSync(join(ws.path, "dir"));
      await expect(registerArtifact(prisma, { workspaceId: ws.id, path: "dir" })).rejects.toThrow(/regular files/);
      await expect(registerArtifact(prisma, { workspaceId: ws.id, path: "missing.txt" })).rejects.toThrow(/not found/);

      const first = await registerArtifact(prisma, { workspaceId: ws.id, path: "out.txt", kind: "OUTPUT" });
      const again = await registerArtifact(prisma, { workspaceId: ws.id, path: "out.txt", kind: "OUTPUT" });
      expect(again.id).toBe(first.id);
      expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.path).toBe("out.txt");
      expect(first.mimeType).toBe("text/plain");
      expect(await prisma.eventLog.count({ where: { type: "ARTIFACT_CREATED", targetId: first.id } })).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("real child processes", () => {
  it("do not inherit secrets and treat shell metacharacters as inert data", async () => {
    const root = tempRoot();
    process.env.KW_SECRET_TOKEN = "s3cret-value";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    try {
      const ws = await workspace(root, {
        "probe.js":
          "require('fs').writeFileSync('report.json', JSON.stringify({" +
          "keys: Object.keys(process.env).filter(k => /SECRET|TOKEN|KEY|PASSWORD/i.test(k))," +
          "argv: process.argv.slice(2) }));",
      });
      const hostile = ["; touch pwned", "&& echo hi > pwned2", "$(touch pwned3)", "`touch pwned4`", "| tee pwned5"];
      const job = await enqueueExecution(prisma, {
        kind: "COMMAND",
        command: JSON.stringify(["node", "probe.js", ...hostile]),
        actor: SYSTEM,
        correlationId: CORRELATION,
        backendId: "local",
        workspaceId: ws.id,
        // Arguments here are not paths; the policy only needs to allow `node probe.js`.
      });
      expect(await runJob(prisma, job.id)).toMatchObject({ status: "COMPLETED" });

      const report = JSON.parse(readFileSync(join(ws.path, "report.json"), "utf8")) as { keys: string[]; argv: string[] };
      expect(report.keys).toEqual([]);
      expect(report.argv).toEqual(hostile); // passed through verbatim, never interpreted
      for (const name of ["pwned", "pwned2", "pwned3", "pwned4", "pwned5"]) {
        expect(existsSync(join(ws.path, name)), name).toBe(false);
      }
      expect(filterEnv().KW_SECRET_TOKEN).toBeUndefined();
    } finally {
      delete process.env.KW_SECRET_TOKEN;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REST path handling", () => {
  it("never lists outside a workspace for encoded or double-encoded traversal", async () => {
    const app = createApp();
    const root = tempRoot();
    try {
      const email = `${unique("secapi")}@test.local`.toLowerCase();
      await prisma.user.create({
        data: { email, passwordHash: hashPassword("TestPassword123", 10), displayName: "Sec", role: "OWNER", isActive: true },
      });
      const login = await request(app).post("/api/v1/auth/login").send({ email, password: "TestPassword123" });
      const auth = { Authorization: `Bearer ${login.body.token as string}` };
      const ws = await workspace(root);

      for (const path of ["..", "%2e%2e", "..%2f..", "%252e%252e", "..\\..", "C:\\Windows", "\\\\server\\share"]) {
        const res = await request(app).get(`/api/v1/workspaces/${ws.id}/files?path=${encodeURIComponent(path)}`).set(auth);
        expect([400, 404], path).toContain(res.status);
      }
      const artifacts = await request(app).get(`/api/v1/workspaces/${ws.id}/artifacts`).set(auth);
      expect(artifacts.status).toBe(200);
      const missing = await request(app).get("/api/v1/workspaces/cl_nope/artifacts").set(auth);
      expect(missing.status).toBe(404);
      const anon = await request(app).get(`/api/v1/workspaces/${ws.id}/artifacts`);
      expect(anon.status).toBe(401);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
