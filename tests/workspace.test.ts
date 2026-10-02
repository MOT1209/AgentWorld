import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prisma } from "../packages/database/src/client.js";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  setWorkspaceStatus,
  shareWorkspace,
  unshareWorkspace,
  archiveWorkspace,
  reapExpiredWorkspaces,
  resolveInRoot,
  defaultWorkspaceRoot,
  workspaceEnvironment,
  type WorkspaceActorContext,
} from "../packages/workspace/src/index.js";
import type { Permission } from "../packages/security/src/permissions.js";
import { SYSTEM, CORRELATION, createTestAgent, createTestUser, unique } from "./helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "agentworld-ws-"));
}

function agentCtx(agentId: string, perms: Permission[] = ["workspace.read", "workspace.write"]): WorkspaceActorContext {
  return {
    actor: { actorType: "AGENT", actorId: agentId },
    agentId,
    permissions: new Set(perms),
    correlationId: CORRELATION,
  };
}

function humanCtx(perms: Permission[], userId: string): WorkspaceActorContext {
  return {
    actor: { actorType: "USER", actorId: userId },
    userId,
    permissions: new Set(perms),
    correlationId: CORRELATION,
  };
}

const SYSTEM_CTX: WorkspaceActorContext = { actor: SYSTEM, correlationId: CORRELATION };

describe("workspace path guard", () => {
  it("keeps every resolved path inside the root", () => {
    const root = tempRoot();
    try {
      expect(resolveInRoot(root, "ok")).toBe(resolve(root, "ok"));
      expect(resolveInRoot(root, "a", "b.txt")).toBe(resolve(root, "a", "b.txt"));
      mkdirSync(join(root, "existing"), { recursive: true });
      expect(resolveInRoot(root, "existing")).toBe(resolve(root, "existing"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects parent-directory references", () => {
    const root = tempRoot();
    try {
      expect(() => resolveInRoot(root, "..")).toThrow(/escapes the workspace root|Parent-directory/);
      expect(() => resolveInRoot(root, "sub/../../outside")).toThrow();
      // Stays inside after normalization, so the explicit `..` ban fires.
      expect(() => resolveInRoot(root, "a/../b")).toThrow(/Parent-directory/);
      expect(() => resolveInRoot(root, "..", "sibling")).toThrow(/escapes the workspace root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths that land outside the root", () => {
    const root = tempRoot();
    const outside = join(tmpdir(), unique("outside"));
    try {
      expect(() => resolveInRoot(root, outside)).toThrow(/escapes the workspace root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an existing symlink that resolves outside the root", () => {
    const root = tempRoot();
    const outside = mkdtempSync(join(tmpdir(), "agentworld-outside-"));
    try {
      mkdirSync(join(root, "project"), { recursive: true });
      let linked = false;
      try {
        symlinkSync(outside, join(root, "project", "escape"), "junction");
        linked = true;
      } catch {
        // Junction creation can be denied on hardened hosts; the escape
        // itself is still proven by the absolute-path case above.
      }
      if (linked) {
        expect(() => resolveInRoot(root, "project", "escape")).toThrow(/outside the workspace root/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to create a workspace directory outside the root", async () => {
    const root = tempRoot();
    try {
      const agent = await createTestAgent({ name: "Escape Artist" });
      await expect(
        createWorkspace(prisma, { name: unique("Escape"), dir: "../evil" }, agentCtx(agent.id), { root }),
      ).rejects.toThrow(/Parent-directory|escapes the workspace root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults to the repo-local workspaces root", () => {
    expect(defaultWorkspaceRoot()).toBe(resolve(process.cwd(), "workspaces"));
  });
});

describe("workspace lifecycle", () => {
  it("creates a directory, a READY row, and a WORKSPACE_CREATED event", async () => {
    const root = tempRoot();
    try {
      const agent = await createTestAgent({ name: "Workspace Holder" });
      const ws = await createWorkspace(
        prisma,
        { name: unique("Holder den"), agentId: agent.id, environment: { runtime: "node20" } },
        agentCtx(agent.id),
        { root },
      );
      expect(ws.status).toBe("READY");
      expect(ws.path.startsWith(resolve(root))).toBe(true);
      expect(existsSync(ws.path)).toBe(true);
      expect(workspaceEnvironment(ws)).toEqual({ runtime: "node20" });

      const event = await prisma.eventLog.findFirst({
        where: { type: "WORKSPACE_CREATED", targetId: ws.id },
        orderBy: { id: "desc" },
      });
      expect(event).not.toBeNull();

      const fetched = await getWorkspace(prisma, ws.id, agentCtx(agent.id));
      expect(fetched.id).toBe(ws.id);

      const listed = await listWorkspaces(prisma, { agentId: agent.id });
      expect(listed.some((w) => w.id === ws.id)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates name, type, status, and missing agents", async () => {
    const root = tempRoot();
    try {
      const agent = await createTestAgent({ name: "Validator" });
      await expect(
        createWorkspace(prisma, { name: "x" }, SYSTEM_CTX, { root }),
      ).rejects.toThrow();
      await expect(
        createWorkspace(prisma, { name: unique("BadType"), type: "BOGUS" }, SYSTEM_CTX, { root }),
      ).rejects.toThrow();
      await expect(
        createWorkspace(prisma, { name: unique("NoAgent"), agentId: "missing-agent" }, SYSTEM_CTX, { root }),
      ).rejects.toThrow(/not found/i);

      const ws = await createWorkspace(prisma, { name: unique("Status"), agentId: agent.id }, SYSTEM_CTX, { root });
      await expect(setWorkspaceStatus(prisma, ws.id, "NIRVANA", SYSTEM_CTX)).rejects.toThrow();
      // Duplicate directory names collide on the unique path.
      await expect(
        createWorkspace(prisma, { name: unique("Dup"), dir: "same-dir" }, SYSTEM_CTX, { root }),
      ).resolves.toBeTruthy();
      await expect(
        createWorkspace(prisma, { name: unique("Dup"), dir: "same-dir" }, SYSTEM_CTX, { root }),
      ).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("changes status with an event and treats same-status as a no-op", async () => {
    const root = tempRoot();
    try {
      const ws = await createWorkspace(prisma, { name: unique("Statuses") }, SYSTEM_CTX, { root });
      const busy = await setWorkspaceStatus(prisma, ws.id, "BUSY", SYSTEM_CTX);
      expect(busy.status).toBe("BUSY");
      const event = await prisma.eventLog.findFirst({
        where: { type: "WORKSPACE_STATUS_CHANGED", targetId: ws.id },
        orderBy: { id: "desc" },
      });
      expect(event).not.toBeNull();

      const same = await setWorkspaceStatus(prisma, ws.id, "BUSY", SYSTEM_CTX);
      expect(same.status).toBe("BUSY");
      const eventsAfter = await prisma.eventLog.count({
        where: { type: "WORKSPACE_STATUS_CHANGED", targetId: ws.id },
      });
      expect(eventsAfter).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shares with MEMBER (read+write), downgrades to READER (read-only), and unshares", async () => {
    const root = tempRoot();
    try {
      const holder = await createTestAgent({ name: "Share Holder" });
      const guest = await createTestAgent({ name: "Share Guest" });
      const ws = await createWorkspace(
        prisma,
        { name: unique("Shared"), agentId: holder.id },
        agentCtx(holder.id),
        { root },
      );

      // Stranger: no access at all.
      await expect(getWorkspace(prisma, ws.id, agentCtx(guest.id))).rejects.toThrow(/No read access/);
      await expect(setWorkspaceStatus(prisma, ws.id, "PAUSED", agentCtx(guest.id))).rejects.toThrow(/No write access/);

      await shareWorkspace(prisma, ws.id, { agentId: guest.id, role: "MEMBER" }, agentCtx(holder.id));
      const memberRead = await getWorkspace(prisma, ws.id, agentCtx(guest.id));
      expect(memberRead.id).toBe(ws.id);
      const paused = await setWorkspaceStatus(prisma, ws.id, "PAUSED", agentCtx(guest.id));
      expect(paused.status).toBe("PAUSED");

      // Downgrade: readers read, never write.
      await shareWorkspace(prisma, ws.id, { agentId: guest.id, role: "READER" }, agentCtx(holder.id));
      await expect(getWorkspace(prisma, ws.id, agentCtx(guest.id))).resolves.toBeTruthy();
      await expect(setWorkspaceStatus(prisma, ws.id, "BUSY", agentCtx(guest.id))).rejects.toThrow(/No write access/);

      await unshareWorkspace(prisma, ws.id, guest.id, agentCtx(holder.id));
      await expect(getWorkspace(prisma, ws.id, agentCtx(guest.id))).rejects.toThrow(/No read access/);

      // Only the holder (or workspace.share) may share.
      await expect(
        shareWorkspace(prisma, ws.id, { agentId: holder.id }, agentCtx(guest.id)),
      ).rejects.toThrow(/share this workspace/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("archives without deleting the directory and reaps expired TEMPORARY workspaces", async () => {
    const root = tempRoot();
    try {
      const holder = await createTestAgent({ name: "Archivist" });
      const ws = await createWorkspace(
        prisma,
        { name: unique("Doomed"), agentId: holder.id },
        agentCtx(holder.id),
        { root },
      );
      const archived = await archiveWorkspace(prisma, ws.id, agentCtx(holder.id));
      expect(archived.status).toBe("ARCHIVED");
      expect(existsSync(ws.path)).toBe(true);

      // Only the holder or workspace.delete may archive.
      const stranger = await createTestAgent({ name: "Not The Holder" });
      await expect(archiveWorkspace(prisma, ws.id, agentCtx(stranger.id, ["workspace.delete"]))).rejects.toThrow(
        /archive this workspace/,
      );

      // TTL reap: expired TEMPORARY rows are archived, everything else is not.
      const tmp = await createWorkspace(
        prisma,
        { name: unique("Temps"), type: "TEMPORARY", environment: { ttlHours: 1 } },
        SYSTEM_CTX,
        { root },
      );
      const personal = await createWorkspace(
        prisma,
        { name: unique("Keeper"), environment: { ttlHours: 1 } },
        SYSTEM_CTX,
        { root },
      );
      const future = new Date(tmp.createdAt.getTime() + 2 * 3_600_000);
      const past = new Date(tmp.createdAt.getTime() + 30 * 60_000);

      const reaped = await reapExpiredWorkspaces(prisma, SYSTEM_CTX, future);
      expect(reaped).toBeGreaterThanOrEqual(1);
      const reapedRow = await prisma.workspace.findUniqueOrThrow({ where: { id: tmp.id } });
      expect(reapedRow.status).toBe("ARCHIVED");
      const personalRow = await prisma.workspace.findUniqueOrThrow({ where: { id: personal.id } });
      expect(personalRow.status).toBe("READY");
      const untouched = await reapExpiredWorkspaces(prisma, SYSTEM_CTX, past);
      expect(untouched).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("workspace access control", () => {
  it("grants the holder everything and humans only what their permissions say", async () => {
    const root = tempRoot();
    try {
      const holder = await createTestAgent({ name: "Human Workspace Owner" });
      const ws = await createWorkspace(
        prisma,
        { name: unique("Human Case"), agentId: holder.id },
        agentCtx(holder.id),
        { root },
      );

      // Holder writes without extra grants beyond workspace.write.
      await expect(setWorkspaceStatus(prisma, ws.id, "PAUSED", agentCtx(holder.id))).resolves.toBeTruthy();

      // Humans: no workspace.read -> cannot even fetch; read-only -> fetch, no write.
      const human = await createTestUser();
      const uid = human.id;
      await expect(getWorkspace(prisma, ws.id, humanCtx(["task.read"], uid))).rejects.toThrow(/No read access/);
      await expect(getWorkspace(prisma, ws.id, humanCtx(["workspace.read"], uid))).resolves.toBeTruthy();
      await expect(setWorkspaceStatus(prisma, ws.id, "BUSY", humanCtx(["workspace.read"], uid))).rejects.toThrow(
        /No write access/,
      );
      await expect(setWorkspaceStatus(prisma, ws.id, "BUSY", humanCtx(["workspace.write"], uid))).resolves.toBeTruthy();

      // Creating requires workspace.write when permissions are declared.
      await expect(
        createWorkspace(prisma, { name: unique("NoPerm") }, humanCtx(["workspace.read"], uid), { root }),
      ).rejects.toThrow(/workspace\.write/);
      await expect(
        createWorkspace(prisma, { name: unique("Perm") }, humanCtx(["workspace.write"], uid), { root }),
      ).resolves.toBeTruthy();

      // SYSTEM bypasses every check.
      await expect(getWorkspace(prisma, ws.id, SYSTEM_CTX)).resolves.toBeTruthy();
      await expect(archiveWorkspace(prisma, ws.id, SYSTEM_CTX)).resolves.toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
