/**
 * Workspace service — real work environments, independent of simulation.
 *
 * An AgentWorkspace is a directory under an approved root plus a database
 * row describing it. The simulation may know an agent is WORKING; the work
 * itself happens here. Rules worth stating:
 *
 *  1. ROOTS ARE CLOSED. Every path resolves inside an approved root or the
 *     call fails. `..` escapes, absolute-path smuggling, and symlinks
 *     pointing outside are rejected server-side — never trust model output.
 *  2. ACCESS IS EXPLICIT. Holder, member (OWNER/MEMBER write, READER reads),
 *     or a human holding the matching `workspace.*` permission. Nothing else.
 *  3. NO SECRETS IN ROWS. `environment` holds references and configuration,
 *     never secret values.
 *  4. ARCHIVE, DON'T VANISH. Retirement sets ARCHIVED; hard delete drops the
 *     row but leaves the directory on disk and says so in the audit trail.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";
import {
  WorkspaceMemberRoleSchema,
  WorkspaceStatusSchema,
  WorkspaceTypeSchema,
  conflict,
  forbidden,
  newCorrelationId,
  notFound,
  slugify,
  toJson,
  toJsonObject,
  validationError,
  type ActorRef,
} from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Workspace } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";

export interface WorkspaceActorContext {
  actor: ActorRef;
  /** Absent means SYSTEM: unrestricted internal use. */
  permissions?: ReadonlySet<Permission>;
  agentId?: string;
  userId?: string;
  correlationId?: string;
  companyId?: string;
  worldId?: string;
}

export interface CreateWorkspaceInput {
  name: string;
  agentId?: string | null;
  projectId?: string | null;
  type?: string;
  /** Directory name under the root. Defaults to a slug of the name. */
  dir?: string;
  environment?: Record<string, unknown>;
  workspaceLocationId?: string | null;
}

export interface ListWorkspacesQuery {
  agentId?: string;
  projectId?: string;
  type?: string;
  status?: string | string[];
  take?: number;
  skip?: number;
}

/** Default root: `<cwd>/workspaces`. Tests pass an explicit temp root. */
export function defaultWorkspaceRoot(): string {
  return resolve(process.cwd(), "workspaces");
}

function has(ctx: WorkspaceActorContext, permission: Permission): boolean {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.permissions === undefined) return true;
  return ctx.permissions.has(permission);
}

/**
 * Joins segments under root and proves the result stays inside it.
 * Throws validationError on `..` escapes, absolute smuggling (POSIX, UNC and
 * drive-letter forms on every platform), and symlink escapes.
 *
 * Symlinks are checked against the nearest EXISTING ancestor, so a path that
 * does not exist yet (a write target) cannot be created through a link that
 * points outside the root.
 */
export function resolveInRoot(root: string, ...segments: string[]): string {
  const base = resolve(root);
  const joined = segments.join("/");
  const candidate = resolve(base, ...segments.map((s) => normalize(s)));
  if (candidate !== base && !candidate.startsWith(base + sep)) {
    throw validationError("Path escapes the workspace root", { candidate });
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(joined)) {
    throw validationError("Parent-directory references are not allowed in workspace paths");
  }
  if (segments.some((s) => /^[a-zA-Z]:/.test(s) || s.startsWith("\\\\"))) {
    throw validationError("Drive-letter and UNC paths are not allowed in workspace paths");
  }

  let realBase = base;
  try {
    realBase = realpathSync(base);
  } catch {
    // Root not created yet (createWorkspace resolves before mkdir).
  }

  let probe = candidate;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return candidate;
    probe = parent;
  }
  const real = realpathSync(probe);
  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw validationError("Path resolves outside the workspace root");
  }
  return probe === candidate ? real : candidate;
}

export async function requireWorkspace(db: DbClient, workspaceId: string): Promise<Workspace> {
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (workspace === null) throw notFound("Workspace", workspaceId);
  return workspace;
}

async function memberRole(db: DbClient, workspaceId: string, agentId: string): Promise<string | null> {
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_agentId: { workspaceId, agentId } },
  });
  return member?.role ?? null;
}

/** True when the caller may read this workspace (holder, member, or human). */
export async function canReadWorkspace(
  db: DbClient,
  workspace: Workspace,
  ctx: WorkspaceActorContext,
): Promise<boolean> {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.agentId !== undefined) {
    if (workspace.agentId === ctx.agentId) return true;
    return (await memberRole(db, workspace.id, ctx.agentId)) !== null;
  }
  return has(ctx, PERMISSIONS.WORKSPACE_READ);
}

/** True when the caller may mutate it (holder, OWNER/MEMBER, or human writer). */
export async function canWriteWorkspace(
  db: DbClient,
  workspace: Workspace,
  ctx: WorkspaceActorContext,
): Promise<boolean> {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.agentId !== undefined) {
    if (workspace.agentId === ctx.agentId) return true;
    const role = await memberRole(db, workspace.id, ctx.agentId);
    return role === "OWNER" || role === "MEMBER";
  }
  return has(ctx, PERMISSIONS.WORKSPACE_WRITE);
}

function assertReadable(db: DbClient, workspace: Workspace, ctx: WorkspaceActorContext): Promise<void> {
  return canReadWorkspace(db, workspace, ctx).then((ok) => {
    if (!ok) throw forbidden("No read access to this workspace", { workspaceId: workspace.id });
  });
}

function assertWritable(db: DbClient, workspace: Workspace, ctx: WorkspaceActorContext): Promise<void> {
  return canWriteWorkspace(db, workspace, ctx).then((ok) => {
    if (!ok) throw forbidden("No write access to this workspace", { workspaceId: workspace.id });
  });
}

export async function createWorkspace(
  db: DbClient,
  input: CreateWorkspaceInput,
  ctx: WorkspaceActorContext,
  opts: { root?: string } = {},
): Promise<Workspace> {
  if (!has(ctx, PERMISSIONS.WORKSPACE_WRITE)) {
    throw forbidden("Caller lacks 'workspace.write'");
  }
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw validationError("Workspace name must be 2-120 characters");
  const type = WorkspaceTypeSchema.parse(input.type ?? "PERSONAL");

  if (input.agentId != null) {
    const agent = await db.agent.findUnique({ where: { id: input.agentId }, select: { id: true } });
    if (agent === null) throw notFound("Agent", input.agentId);
  }
  if (input.projectId != null) {
    const project = await db.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
    if (project === null) throw notFound("Project", input.projectId);
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const root = resolve(opts.root ?? defaultWorkspaceRoot());
  const dir = input.dir ?? `${slugify(name)}-${Date.now().toString(36)}`;
  if (dir.length === 0 || dir.length > 120) throw validationError("Workspace directory name is invalid");
  const path = resolveInRoot(root, dir);

  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throw conflict("Could not create the workspace directory", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const workspace = await db.workspace.create({
    data: {
      name,
      agentId: input.agentId ?? null,
      projectId: input.projectId ?? null,
      type,
      path,
      status: "READY",
      environment: toJson(input.environment ?? {}),
      workspaceLocationId: input.workspaceLocationId ?? null,
    },
  });

  // The holder administers its own workspace without a separate member row.
  // Explicit members are for sharing (see shareWorkspace).
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WORKSPACE_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "Workspace",
    targetId: workspace.id,
    companyId: ctx.companyId,
    worldId: ctx.worldId,
    payload: { workspaceId: workspace.id, name, agentId: workspace.agentId },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "workspace.create",
    targetType: "Workspace",
    targetId: workspace.id,
    correlationId,
    userId: ctx.userId,
    metadata: { name, type, path },
  });

  return workspace;
}

export async function getWorkspace(
  db: DbClient,
  workspaceId: string,
  ctx: WorkspaceActorContext,
): Promise<Workspace> {
  const workspace = await requireWorkspace(db, workspaceId);
  await assertReadable(db, workspace, ctx);
  return workspace;
}

export async function listWorkspaces(db: DbClient, query: ListWorkspacesQuery = {}): Promise<Workspace[]> {
  const statuses =
    query.status === undefined ? undefined : Array.isArray(query.status) ? query.status : [query.status];
  return db.workspace.findMany({
    where: {
      ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(statuses !== undefined ? { status: { in: statuses } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(query.take ?? 50, 200),
    skip: query.skip ?? 0,
  });
}

export async function setWorkspaceStatus(
  db: DbClient,
  workspaceId: string,
  to: string,
  ctx: WorkspaceActorContext,
): Promise<Workspace> {
  const status = WorkspaceStatusSchema.parse(to);
  const workspace = await requireWorkspace(db, workspaceId);
  await assertWritable(db, workspace, ctx);
  if (workspace.status === status) return workspace;

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const updated = await db.workspace.update({ where: { id: workspace.id }, data: { status } });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WORKSPACE_STATUS_CHANGED,
    actor: ctx.actor,
    correlationId,
    targetType: "Workspace",
    targetId: workspace.id,
    payload: { workspaceId: workspace.id, fromStatus: workspace.status, toStatus: status },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "workspace.status",
    targetType: "Workspace",
    targetId: workspace.id,
    correlationId,
    metadata: { fromStatus: workspace.status, toStatus: status },
  });

  return updated;
}

export async function shareWorkspace(
  db: DbClient,
  workspaceId: string,
  input: { agentId: string; role?: string },
  ctx: WorkspaceActorContext,
): Promise<void> {
  const workspace = await requireWorkspace(db, workspaceId);
  const role = WorkspaceMemberRoleSchema.parse(input.role ?? "MEMBER");

  const mayShare =
    ctx.actor.actorType === "SYSTEM" ||
    (ctx.agentId !== undefined &&
      (workspace.agentId === ctx.agentId || (await memberRole(db, workspace.id, ctx.agentId)) === "OWNER")) ||
    (ctx.agentId === undefined && has(ctx, PERMISSIONS.WORKSPACE_SHARE));
  if (!mayShare) throw forbidden("Only the holder, an OWNER member, or workspace.share may share this workspace");

  const agent = await db.agent.findUnique({ where: { id: input.agentId }, select: { id: true } });
  if (agent === null) throw notFound("Agent", input.agentId);

  await db.workspaceMember.upsert({
    where: { workspaceId_agentId: { workspaceId: workspace.id, agentId: agent.id } },
    create: { workspaceId: workspace.id, agentId: agent.id, role },
    update: { role },
  });

  const correlationId = ctx.correlationId ?? newCorrelationId();
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WORKSPACE_MEMBER_ADDED,
    actor: ctx.actor,
    correlationId,
    targetType: "Workspace",
    targetId: workspace.id,
    payload: { workspaceId: workspace.id, agentId: agent.id, role },
  });
}

export async function unshareWorkspace(
  db: DbClient,
  workspaceId: string,
  agentId: string,
  ctx: WorkspaceActorContext,
): Promise<void> {
  const workspace = await requireWorkspace(db, workspaceId);
  const mayShare =
    ctx.actor.actorType === "SYSTEM" ||
    (ctx.agentId !== undefined &&
      (workspace.agentId === ctx.agentId || (await memberRole(db, workspace.id, ctx.agentId)) === "OWNER")) ||
    (ctx.agentId === undefined && has(ctx, PERMISSIONS.WORKSPACE_SHARE));
  if (!mayShare) throw forbidden("Only the holder, an OWNER member, or workspace.share may unshare this workspace");

  await db.workspaceMember.deleteMany({ where: { workspaceId: workspace.id, agentId } });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WORKSPACE_MEMBER_REMOVED,
    actor: ctx.actor,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "Workspace",
    targetId: workspace.id,
    payload: { workspaceId: workspace.id, agentId },
  });
}

/** Retire to ARCHIVED. The directory stays on disk; see the audit trail. */
export async function archiveWorkspace(
  db: DbClient,
  workspaceId: string,
  ctx: WorkspaceActorContext,
): Promise<Workspace> {
  const workspace = await requireWorkspace(db, workspaceId);
  const mayArchive =
    ctx.actor.actorType === "SYSTEM" ||
    (ctx.agentId !== undefined && workspace.agentId === ctx.agentId) ||
    (ctx.agentId === undefined && has(ctx, PERMISSIONS.WORKSPACE_DELETE));
  if (!mayArchive) throw forbidden("Only the holder or workspace.delete may archive this workspace");
  return setWorkspaceStatusRaw(db, workspace, "ARCHIVED", ctx);
}

async function setWorkspaceStatusRaw(
  db: DbClient,
  workspace: Workspace,
  status: "ARCHIVED",
  ctx: WorkspaceActorContext,
): Promise<Workspace> {
  if (workspace.status === status) return workspace;
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const updated = await db.workspace.update({ where: { id: workspace.id }, data: { status } });
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WORKSPACE_STATUS_CHANGED,
    actor: ctx.actor,
    correlationId,
    targetType: "Workspace",
    targetId: workspace.id,
    payload: { workspaceId: workspace.id, fromStatus: workspace.status, toStatus: status },
  });
  return updated;
}

/**
 * Archive expired TEMPORARY workspaces. TTL comes from
 * `environment.ttlHours`; rows without one live forever. Directories are
 * left on disk for inspection.
 */
export async function reapExpiredWorkspaces(
  db: DbClient,
  ctx: WorkspaceActorContext,
  now: Date = new Date(),
): Promise<number> {
  const candidates = await db.workspace.findMany({
    where: { type: "TEMPORARY", status: { not: "ARCHIVED" } },
  });
  let reaped = 0;
  for (const workspace of candidates) {
    const env = toJsonObject(workspace.environment);
    const ttlHours = typeof env.ttlHours === "number" ? env.ttlHours : null;
    if (ttlHours === null) continue;
    const expiresAt = workspace.createdAt.getTime() + ttlHours * 3_600_000;
    if (expiresAt <= now.getTime()) {
      await setWorkspaceStatusRaw(db, workspace, "ARCHIVED", ctx);
      reaped += 1;
    }
  }
  return reaped;
}

export function workspaceEnvironment(workspace: Workspace): Record<string, unknown> {
  return toJsonObject(workspace.environment);
}
