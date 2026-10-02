/**
 * Workspace tools.
 *
 * Agents manage real work environments through these: open one, read its
 * state, share it with a teammate, retire it. Execution *inside* the
 * workspace (terminal, files, git) arrives as later tool families that all
 * resolve through the same root guard.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import {
  archiveWorkspace,
  createWorkspace,
  defaultWorkspaceRoot,
  getWorkspace,
  listWorkspaces,
  setWorkspaceStatus,
  shareWorkspace,
  workspaceEnvironment,
} from "../../../workspace/src/index.js";
import type { ToolDefinition } from "../types.js";

function describeWorkspace(row: {
  id: string;
  name: string;
  type: string;
  status: string;
  path: string;
  agentId: string | null;
}): Record<string, unknown> {
  return { id: row.id, name: row.name, type: row.type, status: row.status, path: row.path, agentId: row.agentId };
}

export const workspaceCreateTool: ToolDefinition<{
  name: string;
  agentId?: string;
  projectId?: string;
  type?: "PERSONAL" | "PROJECT" | "TEMPORARY" | "SHARED";
  dir?: string;
  environment?: Record<string, unknown>;
}> = {
  name: "workspace.create",
  description:
    "Open a real work environment: a directory under an approved root plus " +
    "its registry record. Returns the path to work in.",
  inputSchema: z.object({
    name: z.string().min(2).max(120),
    agentId: z.string().optional(),
    projectId: z.string().optional(),
    type: z.enum(["PERSONAL", "PROJECT", "TEMPORARY", "SHARED"]).default("PERSONAL"),
    dir: z.string().min(1).max(120).optional(),
    environment: z.record(z.string(), z.unknown()).optional(),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "MEDIUM",
  async execute(context, input) {
    const workspace = await createWorkspace(
      context.db,
      {
        name: input.name,
        agentId: input.agentId ?? context.agentId ?? null,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        type: input.type,
        ...(input.dir !== undefined ? { dir: input.dir } : {}),
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      },
      {
        actor: context.actor,
        correlationId: context.correlationId,
        permissions: context.permissions,
        ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
        ...(context.actor.actorType === "USER" && context.actor.actorId !== undefined
          ? { userId: context.actor.actorId }
          : {}),
      },
      { root: defaultWorkspaceRoot() },
    );
    return {
      data: describeWorkspace(workspace),
      summary: `Workspace ${workspace.id} "${workspace.name}" ready at ${workspace.path}`,
    };
  },
};

export const workspaceListTool: ToolDefinition<{ type?: string; status?: string; limit?: number }> = {
  name: "workspace.list",
  description: "List workspaces you can see, optionally filtered by type or status.",
  inputSchema: z.object({
    type: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const workspaces = await listWorkspaces(context.db, {
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      take: input.limit,
    });
    return {
      data: { workspaces: workspaces.map(describeWorkspace) },
      summary: `${workspaces.length} workspace(s)`,
    };
  },
};

export const workspaceGetTool: ToolDefinition<{ workspaceId: string }> = {
  name: "workspace.get",
  description: "Read one workspace: state, environment summary, and path.",
  inputSchema: z.object({ workspaceId: z.string() }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await getWorkspace(context.db, input.workspaceId, {
      actor: context.actor,
      correlationId: context.correlationId,
      permissions: context.permissions,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
    });
    return {
      data: { ...describeWorkspace(workspace), environment: workspaceEnvironment(workspace) },
      summary: `Workspace ${workspace.id} is ${workspace.status}`,
    };
  },
};

export const workspaceStatusTool: ToolDefinition<{ workspaceId: string; status: string }> = {
  name: "workspace.status",
  description: "Move a workspace between READY, BUSY, PAUSED, ERROR, and ARCHIVED.",
  inputSchema: z.object({
    workspaceId: z.string(),
    status: z.enum(["READY", "BUSY", "PAUSED", "ERROR", "ARCHIVED"]),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await setWorkspaceStatus(context.db, input.workspaceId, input.status, {
      actor: context.actor,
      correlationId: context.correlationId,
      permissions: context.permissions,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
    });
    return {
      data: describeWorkspace(workspace),
      summary: `Workspace ${workspace.id} is now ${workspace.status}`,
    };
  },
};

export const workspaceShareTool: ToolDefinition<{ workspaceId: string; agentId: string; role?: string }> = {
  name: "workspace.share",
  description: "Share a workspace you hold (or own as member) with another agent.",
  inputSchema: z.object({
    workspaceId: z.string(),
    agentId: z.string(),
    role: z.enum(["OWNER", "MEMBER", "READER"]).default("MEMBER"),
  }),
  // Coarse gate only: the service enforces holder / OWNER-member /
  // workspace.share before anyone is actually added.
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "MEDIUM",
  async execute(context, input) {
    await shareWorkspace(
      context.db,
      input.workspaceId,
      { agentId: input.agentId, role: input.role },
      {
        actor: context.actor,
        correlationId: context.correlationId,
        permissions: context.permissions,
        ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      },
    );
    return {
      data: { workspaceId: input.workspaceId, agentId: input.agentId, role: input.role },
      summary: `Workspace ${input.workspaceId} shared with ${input.agentId} as ${input.role}`,
    };
  },
};

export const workspaceArchiveTool: ToolDefinition<{ workspaceId: string }> = {
  name: "workspace.archive",
  description: "Retire a workspace to ARCHIVED. The directory stays on disk for inspection.",
  inputSchema: z.object({ workspaceId: z.string() }),
  // Coarse gate only: the service enforces holder-or-workspace.delete.
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "MEDIUM",
  async execute(context, input) {
    const workspace = await archiveWorkspace(context.db, input.workspaceId, {
      actor: context.actor,
      correlationId: context.correlationId,
      permissions: context.permissions,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
    });
    return {
      data: describeWorkspace(workspace),
      summary: `Workspace ${workspace.id} archived`,
    };
  },
};

export const workspaceTools = [
  workspaceCreateTool,
  workspaceListTool,
  workspaceGetTool,
  workspaceStatusTool,
  workspaceShareTool,
  workspaceArchiveTool,
];
