/**
 * Workspace file browsing — a read-only, one-level directory listing behind
 * resolveInRoot (normalize -> resolve -> realpath -> inside-root) and the
 * access checks in the workspace service. Symlinks are reported, never
 * followed, so a link inside a workspace cannot leak metadata from outside.
 * File mutation goes through the fs tools, never through this service.
 */
import { readdir, lstat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { DbClient } from "../../database/src/index.js";
import { notFound } from "../../shared/src/index.js";
import { getWorkspace, resolveInRoot, type WorkspaceActorContext } from "./workspace.service.js";

export interface WorkspaceFileEntry {
  name: string;
  type: "FILE" | "DIR" | "SYMLINK" | "OTHER";
  sizeBytes: number | null;
  modifiedAt: string;
}

export interface WorkspaceFileListing {
  /** Normalized workspace-relative path; "" is the root. */
  path: string;
  /** Workspace-relative parent path, or null at the root. */
  parent: string | null;
  entries: WorkspaceFileEntry[];
}

function toRelative(root: string, absolute: string): string {
  const rel = absolute.startsWith(root + sep) ? absolute.slice(root.length + 1) : "";
  return rel.split(sep).join("/");
}

function parentOf(rel: string): string | null {
  if (rel === "") return null;
  const parts = rel.split("/").filter((part) => part !== "");
  parts.pop();
  const parent = parts.join("/");
  return parent === "" ? null : parent;
}

function entryType(stats: Awaited<ReturnType<typeof lstat>>): WorkspaceFileEntry["type"] {
  if (stats.isSymbolicLink()) return "SYMLINK";
  if (stats.isDirectory()) return "DIR";
  if (stats.isFile()) return "FILE";
  return "OTHER";
}

export async function listWorkspaceFiles(
  db: DbClient,
  workspaceId: string,
  relPath: string,
  ctx: WorkspaceActorContext,
): Promise<WorkspaceFileListing> {
  const workspace = await getWorkspace(db, workspaceId, ctx);
  const root = resolveInRoot(workspace.path);
  const target = resolveInRoot(workspace.path, relPath);

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw notFound("Workspace path", relPath === "" ? "/" : relPath);
    }
    throw error;
  }

  const entries: WorkspaceFileEntry[] = [];
  for (const dirent of dirents) {
    const full = join(target, dirent.name);
    const stats = await lstat(full);
    entries.push({
      name: dirent.name,
      type: entryType(stats),
      sizeBytes: stats.isFile() ? stats.size : null,
      modifiedAt: stats.mtime.toISOString(),
    });
  }
  entries.sort((a, b) => {
    const aDir = a.type === "DIR" ? 0 : 1;
    const bDir = b.type === "DIR" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  const rel = toRelative(root, target);
  return { path: rel, parent: parentOf(rel), entries };
}
