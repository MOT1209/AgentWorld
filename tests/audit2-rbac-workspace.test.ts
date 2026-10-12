import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { createDefaultRegistry, ToolExecutor } from "../packages/tools/src/index.js";
import { createWorkspace } from "../packages/workspace/src/index.js";
import { hashPassword } from "../packages/security/src/password.js";
import { signAccessToken } from "../packages/security/src/tokens.js";
import { roleHasPermission } from "../packages/security/src/rbac.js";
import { PERMISSIONS } from "../packages/security/src/permissions.js";
import { UserRole } from "../packages/shared/src/index.js";
import { SYSTEM, CORRELATION, createTestAgent, unique } from "./helpers.js";

// Second-pass audit (2026-10-12): testing.run let any caller with
// TESTING_RUN run commands in a workspace they do not own, bypassing the
// workspace ACL that terminal.exec/fs.*/git.*/execution.* all enforce.
// OBSERVER held TESTING_RUN and FACTORY_RUN by default, so this reached
// a role documented as read-only.

const app = createApp();

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "kw-rbac-"));
}

async function makeUser(role: "OWNER" | "ADMIN" | "OBSERVER"): Promise<{ id: string; email: string; auth: string }> {
  const email = `${unique(role.toLowerCase())}@rbac.test`.toLowerCase();
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword("TestPassword123", 10), displayName: role, role, isActive: true },
  });
  const token = signAccessToken({ userId: user.id, email, displayName: role, role });
  return { id: user.id, email, auth: `Bearer ${token}` };
}

describe("RBAC: OBSERVER is read-only for factory/testing", () => {
  it("does not grant TESTING_RUN or FACTORY_RUN to OBSERVER", () => {
    expect(roleHasPermission(UserRole.OBSERVER, PERMISSIONS.TESTING_RUN)).toBe(false);
    expect(roleHasPermission(UserRole.OBSERVER, PERMISSIONS.FACTORY_RUN)).toBe(false);
    // Reads stay available.
    expect(roleHasPermission(UserRole.OBSERVER, PERMISSIONS.TESTING_READ)).toBe(true);
    expect(roleHasPermission(UserRole.OBSERVER, PERMISSIONS.FACTORY_READ)).toBe(true);
    // ADMIN keeps both (unaffected by narrowing OBSERVER).
    expect(roleHasPermission(UserRole.ADMIN, PERMISSIONS.TESTING_RUN)).toBe(true);
    expect(roleHasPermission(UserRole.ADMIN, PERMISSIONS.FACTORY_RUN)).toBe(true);
  });

  it("rejects an OBSERVER starting a factory run or queueing a test run over REST", async () => {
    const observer = await makeUser("OBSERVER");
    // The observer owns this company themselves, so company-scope lets the
    // request through and the role-permission check is what is on trial.
    const company = await prisma.company.create({ data: { name: unique("RBAC Co"), ownerId: observer.id } });

    const factory = await request(app)
      .post("/api/v1/factory/runs")
      .set("Authorization", observer.auth)
      .send({ repoUrl: "https://github.com/octocat/hello-world", companyId: company.id });
    expect(factory.status).toBe(403);

    const testing = await request(app)
      .post("/api/v1/testing/run")
      .set("Authorization", observer.auth)
      .send({ suite: "SECURITY" });
    expect(testing.status).toBe(403);
  });
});

describe("workspace ACL: testing.run must not execute in a workspace the caller cannot write", () => {
  // Every current human role holding TESTING_RUN (ADMIN, OWNER) also holds
  // the global WORKSPACE_WRITE permission, so canWriteWorkspace always lets
  // them through for a *human* caller -- this mirrors the identical, existing
  // behaviour of POST /executions and is not itself a bug. This is a
  // regression check that the new ACL call did not break that normal path.
  it("REST /testing/run still queues a command run for a human who legitimately holds workspace.write", async () => {
    const root = tempRoot();
    try {
      const workspace = await createWorkspace(
        prisma,
        { name: unique("Owned Bench"), type: "TEMPORARY" },
        { actor: SYSTEM, correlationId: CORRELATION, permissions: new Set([PERMISSIONS.WORKSPACE_WRITE]) },
        { root },
      );
      writeFileSync(join(workspace.path, "write-marker.js"), "require('fs').writeFileSync('ok.txt','x')");
      const admin = await makeUser("ADMIN");
      const res = await request(app)
        .post("/api/v1/testing/run")
        .set("Authorization", admin.auth)
        .send({ workspaceId: workspace.id, command: ["node", "write-marker.js"] });
      expect(res.status).toBe(202);
      expect(await prisma.executionJob.count({ where: { workspaceId: workspace.id } })).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("REST /testing/run 404s rather than run against a non-existent workspace id", async () => {
    const admin = await makeUser("ADMIN");
    const res = await request(app)
      .post("/api/v1/testing/run")
      .set("Authorization", admin.auth)
      .send({ workspaceId: "does-not-exist", command: ["echo", "hi"] });
    expect(res.status).toBe(404);
  });

  it("agent tool testing.run refuses to run a command in a workspace the agent does not own", async () => {
    const root = tempRoot();
    try {
      const owner = await createTestAgent({ name: unique("Workspace Owner") });
      const outsider = await createTestAgent({ name: unique("Workspace Outsider") });
      const workspace = await createWorkspace(
        prisma,
        { name: unique("Owned Bench"), agentId: owner.id, type: "TEMPORARY" },
        { actor: SYSTEM, correlationId: CORRELATION },
        { root },
      );
      writeFileSync(join(workspace.path, "write-marker.js"), "require('fs').writeFileSync('should-not-exist.txt','x')");

      const executor = new ToolExecutor({ registry: createDefaultRegistry() });
      const ctx = {
        agentId: outsider.id,
        actor: { actorType: "AGENT" as const, actorId: outsider.id },
        correlationId: CORRELATION,
        permissions: new Set<string>([PERMISSIONS.TESTING_RUN, PERMISSIONS.WORKSPACE_READ]),
        db: prisma,
        now: new Date(),
      };

      const result = await executor.invoke(
        "testing.run",
        { workspaceId: workspace.id, command: ["node", "write-marker.js"] },
        ctx as never,
      );

      expect(result.status).not.toBe("SUCCESS");
      expect(await prisma.executionJob.count({ where: { workspaceId: workspace.id } }), "no execution job should be queued in a workspace the agent does not own").toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("workspace.create tool must not let an agent name a different owner", () => {
  it("creates the workspace for the calling agent even when a different agentId is given", async () => {
    const root = tempRoot();
    try {
      const caller = await createTestAgent({ name: unique("Create Caller") });
      const victim = await createTestAgent({ name: unique("Create Victim") });

      const executor = new ToolExecutor({ registry: createDefaultRegistry() });
      const ctx = {
        agentId: caller.id,
        actor: { actorType: "AGENT" as const, actorId: caller.id },
        correlationId: CORRELATION,
        permissions: new Set<string>([PERMISSIONS.WORKSPACE_WRITE, PERMISSIONS.WORKSPACE_READ]),
        db: prisma,
        now: new Date(),
      };

      const result = await executor.invoke(
        "workspace.create",
        { name: unique("Spoofed"), agentId: victim.id },
        ctx as never,
      );
      expect(result.status).toBe("SUCCESS");
      const created = (result.data as { id: string }).id;
      const row = await prisma.workspace.findUniqueOrThrow({ where: { id: created } });
      expect(row.agentId, "an agent must not be able to create a workspace owned by a different agent").toBe(caller.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
