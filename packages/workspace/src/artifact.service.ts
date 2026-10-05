/**
 * Artifact service — registers files a run produced so the dashboard can list
 * them. An artifact row stores a path RELATIVE to the workspace root; every
 * registration and every read re-validates it through the path guard, so a row
 * (or a symlink swapped in later) can never point outside the workspace.
 * Rows hold no file contents and no secrets: name, path, size, checksum, MIME.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative } from "node:path";
import type { DbClient } from "../../database/src/index.js";
import type { Artifact } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { SYSTEM_ACTOR, newCorrelationId, notFound, validationError, type ActorRef } from "../../shared/src/index.js";
import { requireWorkspace, resolveInRoot } from "./workspace.service.js";

export const ARTIFACT_KINDS = ["FILE", "LOG", "REPORT", "DIFF", "OUTPUT"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
};

/** Files above this are registered without hashing (size is still recorded). */
const MAX_HASH_BYTES = 64 * 1024 * 1024;

function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export interface RegisterArtifactInput {
  workspaceId: string;
  /** Relative to the workspace root. Absolute inputs are accepted only if they sit inside it. */
  path: string;
  kind?: ArtifactKind;
  name?: string;
  executionId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
}

export async function registerArtifact(
  db: DbClient,
  input: RegisterArtifactInput,
  options?: { actor?: ActorRef; correlationId?: string },
): Promise<Artifact> {
  const kind = input.kind ?? "FILE";
  if (!ARTIFACT_KINDS.includes(kind)) throw validationError(`Unknown artifact kind '${String(kind)}'`);

  const workspace = await requireWorkspace(db, input.workspaceId);
  // Absolute inputs become root-relative first, so `resolveInRoot` is the one judge.
  const requested = isAbsolute(input.path) ? relative(workspace.path, input.path) : input.path;
  const absolute = resolveInRoot(workspace.path, requested);
  const rel = relative(workspace.path, absolute).split("\\").join("/");
  if (rel === "" || rel.startsWith("..")) throw validationError("Artifact path must be a file inside the workspace");

  let size: number;
  try {
    const info = statSync(absolute);
    if (!info.isFile()) throw validationError("Artifacts must be regular files");
    size = info.size;
  } catch (error) {
    if (error instanceof Error && error.message.includes("regular files")) throw error;
    throw notFound("Artifact file", rel);
  }
  const contentHash = size <= MAX_HASH_BYTES ? await sha256(absolute) : null;

  // Idempotent: re-registering the same file for the same run updates the row.
  const existing = await db.artifact.findFirst({
    where: { workspaceId: workspace.id, path: rel, executionId: input.executionId ?? null },
  });
  if (existing !== null) {
    return db.artifact.update({
      where: { id: existing.id },
      data: { sizeBytes: size, contentHash, status: "READY" },
    });
  }

  const artifact = await db.artifact.create({
    data: {
      name: input.name ?? basename(rel),
      kind,
      path: rel,
      sizeBytes: size,
      contentHash,
      mimeType: mimeFor(rel),
      status: "READY",
      workspaceId: workspace.id,
      executionId: input.executionId ?? null,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
    },
  });
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.ARTIFACT_CREATED,
    actor: options?.actor ?? SYSTEM_ACTOR,
    correlationId: options?.correlationId ?? newCorrelationId(),
    targetType: "Artifact",
    targetId: artifact.id,
    payload: { artifactId: artifact.id, workspaceId: workspace.id, kind, path: rel },
  });
  return artifact;
}

export interface ListArtifactsQuery {
  workspaceId?: string;
  executionId?: string;
  kind?: string;
  take?: number;
  skip?: number;
}

export async function listArtifacts(db: DbClient, query: ListArtifactsQuery = {}): Promise<Artifact[]> {
  return db.artifact.findMany({
    where: {
      ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}),
      ...(query.executionId !== undefined ? { executionId: query.executionId } : {}),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(200, Math.max(1, query.take ?? 50)),
    skip: Math.max(0, query.skip ?? 0),
  });
}
