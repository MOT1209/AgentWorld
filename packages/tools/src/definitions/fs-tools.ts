/**
 * Filesystem tools.
 *
 * Agents work with files only inside their authorized workspace: every path
 * resolves through the root guard, so `..` escapes and absolute smuggling
 * fail before touching disk. Reads are LOW; writes are MEDIUM; deletes are
 * HIGH and therefore held for human approval by default.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { PERMISSIONS, type Permission } from "../../../security/src/permissions.js";
import { forbidden, validationError } from "../../../shared/src/index.js";
import {
  canReadWorkspace,
  canWriteWorkspace,
  requireWorkspace,
  resolveInRoot,
  type WorkspaceActorContext,
} from "../../../workspace/src/index.js";
import type { DbClient } from "../../../database/src/index.js";
import type { ToolDefinition, ToolExecutionContext } from "../types.js";
import type { Workspace } from "../../../database/src/types.js";

const READ_MAX_BYTES = 65_536;
const WRITE_MAX_BYTES = 1_048_576;
const SEARCH_ENTRY_CAP = 5000;

function actorCtx(context: ToolExecutionContext): WorkspaceActorContext {
  return {
    actor: context.actor,
    correlationId: context.correlationId,
    permissions: context.permissions as ReadonlySet<Permission>,
    ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
  };
}

async function forRead(db: DbClient, context: ToolExecutionContext, workspaceId: string): Promise<Workspace> {
  const workspace = await requireWorkspace(db, workspaceId);
  if (!(await canReadWorkspace(db, workspace, actorCtx(context)))) {
    throw forbidden("No read access to this workspace", { workspaceId });
  }
  return workspace;
}

async function forWrite(db: DbClient, context: ToolExecutionContext, workspaceId: string): Promise<Workspace> {
  const workspace = await requireWorkspace(db, workspaceId);
  if (!(await canWriteWorkspace(db, workspace, actorCtx(context)))) {
    throw forbidden("No write access to this workspace", { workspaceId });
  }
  return workspace;
}

function inRoot(workspace: Workspace, relPath: string, mutating = false): string {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 500) {
    throw validationError("Workspace path must be a non-empty relative path");
  }
  const resolved = resolveInRoot(workspace.path, relPath);
  if (mutating) {
    // .git/config and .git/hooks make git run programs; agents may not edit them.
    const rel = relative(resolveInRoot(workspace.path, "."), resolved).split(sep);
    if (rel.some((part) => part.toLowerCase() === ".git")) {
      throw forbidden("Writing inside .git is not allowed", { path: relPath });
    }
  }
  return resolved;
}

export const fsListTool: ToolDefinition<{ workspaceId: string; path?: string; limit?: number }> = {
  name: "fs.list",
  description: "List entries in a workspace directory (default: the root).",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    path: z.string().max(500).default("."),
    limit: z.number().int().min(1).max(1000).default(100),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await forRead(context.db, context, input.workspaceId);
    const dir = inRoot(workspace, input.path ?? ".");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw validationError("Not a directory in this workspace", { path: input.path ?? "." });
    }
    const entries = readdirSync(dir, { withFileTypes: true })
      .slice(0, input.limit ?? 100)
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
    return { data: { path: input.path ?? ".", entries }, summary: `${entries.length} entrie(s) in ${input.path ?? "."}` };
  },
};

export const fsReadTool: ToolDefinition<{ workspaceId: string; path: string; maxBytes?: number }> = {
  name: "fs.read",
  description: "Read a text file inside the workspace (bounded; binary refused).",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    path: z.string().min(1).max(500),
    maxBytes: z.number().int().min(1).max(WRITE_MAX_BYTES).default(READ_MAX_BYTES),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await forRead(context.db, context, input.workspaceId);
    const file = inRoot(workspace, input.path);
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw validationError("Not a file in this workspace", { path: input.path });
    }
    const buffer = readFileSync(file);
    if (buffer.includes(0)) throw validationError("Binary files cannot be read as text", { path: input.path });
    const text = buffer.toString("utf8");
    const cap = input.maxBytes ?? READ_MAX_BYTES;
    const truncated = text.length > cap;
    return {
      data: { path: input.path, content: text.slice(0, cap), truncated, size: buffer.length },
      summary: `Read ${input.path} (${buffer.length} bytes${truncated ? ", truncated" : ""})`,
    };
  },
};

export const fsWriteTool: ToolDefinition<{ workspaceId: string; path: string; content: string }> = {
  name: "fs.write",
  description: "Write (or overwrite) a text file inside the workspace. Parents are created.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    path: z.string().min(1).max(500),
    content: z.string().max(WRITE_MAX_BYTES),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "MEDIUM",
  async execute(context, input) {
    const workspace = await forWrite(context.db, context, input.workspaceId);
    const file = inRoot(workspace, input.path, true);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, input.content, "utf8");
    return {
      data: { path: input.path, bytes: Buffer.byteLength(input.content, "utf8") },
      summary: `Wrote ${input.path}`,
    };
  },
};

export const fsMkdirTool: ToolDefinition<{ workspaceId: string; path: string }> = {
  name: "fs.mkdir",
  description: "Create a directory (with parents) inside the workspace.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    path: z.string().min(1).max(500),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await forWrite(context.db, context, input.workspaceId);
    const dir = inRoot(workspace, input.path, true);
    mkdirSync(dir, { recursive: true });
    return { data: { path: input.path }, summary: `Created ${input.path}` };
  },
};

export const fsMoveTool: ToolDefinition<{ workspaceId: string; from: string; to: string }> = {
  name: "fs.move",
  description: "Move/rename a file or directory inside the workspace.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    from: z.string().min(1).max(500),
    to: z.string().min(1).max(500),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "MEDIUM",
  async execute(context, input) {
    const workspace = await forWrite(context.db, context, input.workspaceId);
    const from = inRoot(workspace, input.from, true);
    const to = inRoot(workspace, input.to, true);
    if (!existsSync(from)) throw validationError("Source does not exist in this workspace", { path: input.from });
    mkdirSync(join(to, ".."), { recursive: true });
    renameSync(from, to);
    return { data: { from: input.from, to: input.to }, summary: `Moved ${input.from} to ${input.to}` };
  },
};

export const fsDeleteTool: ToolDefinition<{ workspaceId: string; path: string }> = {
  name: "fs.delete",
  description: "Delete a file or directory inside the workspace. Held for human approval.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    path: z.string().min(1).max(500),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_WRITE,
  risk: "HIGH",
  async execute(context, input) {
    const workspace = await forWrite(context.db, context, input.workspaceId);
    const target = inRoot(workspace, input.path, true);
    if (target === resolveInRoot(workspace.path, ".")) throw forbidden("Refusing to delete the workspace root itself");
    if (!existsSync(target)) throw validationError("Path does not exist in this workspace", { path: input.path });
    rmSync(target, { recursive: true, force: true });
    return { data: { path: input.path }, summary: `Deleted ${input.path}` };
  },
};

function walkNames(dir: string, query: string, limit: number, seen: string[], depth: number): void {
  if (seen.length >= limit || depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (seen.length >= limit) return;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.name.toLowerCase().includes(query)) seen.push(join(dir, entry.name));
    if (entry.isDirectory()) walkNames(join(dir, entry.name), query, limit, seen, depth + 1);
    if (seen.length >= SEARCH_ENTRY_CAP) return;
  }
}

export const fsSearchTool: ToolDefinition<{ workspaceId: string; query: string; path?: string; limit?: number }> = {
  name: "fs.search",
  description: "Search workspace filenames (not contents) for a substring, bounded.",
  inputSchema: z.object({
    workspaceId: z.string().min(1),
    query: z.string().min(1).max(120),
    path: z.string().max(500).default("."),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  requiredPermission: PERMISSIONS.WORKSPACE_READ,
  risk: "LOW",
  async execute(context, input) {
    const workspace = await forRead(context.db, context, input.workspaceId);
    const dir = inRoot(workspace, input.path ?? ".");
    const found: string[] = [];
    walkNames(dir, input.query.toLowerCase(), input.limit ?? 50, found, 0);
    const relative = found.map((absolute) => absolute.slice(workspace.path.length + 1));
    return { data: { query: input.query, matches: relative }, summary: `${relative.length} match(es)` };
  },
};

export const fsTools = [fsListTool, fsReadTool, fsWriteTool, fsMkdirTool, fsMoveTool, fsDeleteTool, fsSearchTool];
