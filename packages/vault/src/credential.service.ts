/**
 * Credential service -- the only writer of `Credential` rows.
 *
 * Security posture:
 *  - `create`/`rotate` seal the plaintext in the vault; the row stores only
 *    ciphertext plus non-secret metadata.
 *  - `reveal` is the single read path that returns plaintext, for server-side
 *    outbound calls only; every call is audited and bumps lastUsedAt.
 *  - `list`/`get` return metadata, never secrets.
 *  - revocation is terminal: revealed credentials of a REVOKED row are refused.
 */
import type { DbClient } from "../../database/src/index.js";
import type { Credential } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { conflict, newCorrelationId, notFound, toJson, validationError, type ActorRef } from "../../shared/src/index.js";
import { open as vaultOpen, seal } from "./vault.js";

const MAX_REVEALS_PER_WINDOW = 120;
const REVEAL_WINDOW_MS = 60_000;
const revealCounter = new Map<string, { count: number; windowStart: number }>();

function rateLimitReveal(credentialId: string): void {
  const now = Date.now();
  const entry = revealCounter.get(credentialId);
  if (entry === undefined || now - entry.windowStart > REVEAL_WINDOW_MS) {
    revealCounter.set(credentialId, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
  if (entry.count > MAX_REVEALS_PER_WINDOW) {
    throw conflict("Credential reveal rate limit exceeded");
  }
}

export interface CreateCredentialInput {
  name: string;
  kind?: string;
  scope: string;
  refId: string;
  secret: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
}

export interface CredentialContext {
  actor: ActorRef;
  correlationId?: string;
}

export function credentialMetadata(row: Credential): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    scope: row.scope,
    refId: row.refId,
    status: row.status,
    metadata: safeParse(row.metadata),
    keyVersion: row.keyVersion,
    hasSecret: row.payload !== "",
    lastRotatedAt: row.lastRotatedAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function createCredential(
  db: DbClient,
  input: CreateCredentialInput,
  ctx: CredentialContext,
): Promise<Credential> {
  if (input.secret === "") throw validationError("Credential secret must not be empty");
  if (input.scope !== "PROVIDER" && input.scope !== "CONNECTOR") {
    throw validationError("Credential scope must be PROVIDER or CONNECTOR");
  }
  const sealed = seal(input.secret);
  const row = await db.credential.create({
    data: {
      name: input.name,
      kind: input.kind ?? "API_KEY",
      scope: input.scope,
      refId: input.refId,
      payload: sealed.payload,
      keyVersion: sealed.keyVersion,
      status: "ACTIVE",
      metadata: toJson(input.metadata ?? {}),
      ...(input.expiresAt !== undefined && input.expiresAt !== null ? { expiresAt: input.expiresAt } : {}),
    },
  });
  const correlationId = ctx.correlationId ?? newCorrelationId();
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.CREDENTIAL_SEALED,
    actor: ctx.actor,
    correlationId,
    targetType: "Credential",
    targetId: row.id,
    payload: { credentialId: row.id, scope: row.scope, refId: row.refId, name: row.name },
  });
  await recordActivity(db, {
    actor: ctx.actor,
    action: "credential.create",
    targetType: "Credential",
    targetId: row.id,
    correlationId,
    metadata: { scope: row.scope, refId: row.refId },
  });
  return row;
}

export async function rotateCredential(
  db: DbClient,
  id: string,
  secret: string,
  ctx: CredentialContext,
): Promise<Credential> {
  if (secret === "") throw validationError("Credential secret must not be empty");
  const row = await db.credential.findUnique({ where: { id } });
  if (row === null) throw notFound("Credential", id);
  const sealed = seal(secret);
  const updated = await db.credential.update({
    where: { id },
    data: { payload: sealed.payload, keyVersion: sealed.keyVersion, lastRotatedAt: new Date(), status: "ACTIVE" },
  });
  await recordActivity(db, {
    actor: ctx.actor,
    action: "credential.rotate",
    targetType: "Credential",
    targetId: id,
    correlationId: ctx.correlationId ?? newCorrelationId(),
  });
  return updated;
}

export async function revokeCredential(
  db: DbClient,
  id: string,
  ctx: CredentialContext,
): Promise<Credential> {
  const row = await db.credential.findUnique({ where: { id } });
  if (row === null) throw notFound("Credential", id);
  if (row.status === "REVOKED") return row;
  const updated = await db.credential.update({
    where: { id },
    data: { status: "REVOKED" },
  });
  const correlationId = ctx.correlationId ?? newCorrelationId();
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.CREDENTIAL_REVOKED,
    actor: ctx.actor,
    correlationId,
    targetType: "Credential",
    targetId: id,
    payload: { credentialId: id, name: row.name },
  });
  await recordActivity(db, {
    actor: ctx.actor,
    action: "credential.revoke",
    targetType: "Credential",
    targetId: id,
    correlationId,
  });
  return updated;
}

/**
 * Single plaintext read path for outbound calls. Audited, rate-limited, and
 * refused for revoked rows. NEVER serialise its result into a DTO or prompt.
 */
export async function revealCredential(
  db: DbClient,
  id: string,
  ctx: CredentialContext,
): Promise<string> {
  rateLimitReveal(id);
  const row = await db.credential.findUnique({ where: { id } });
  if (row === null) throw notFound("Credential", id);
  if (row.status !== "ACTIVE") throw conflict(`Credential '${row.name}' is ${row.status}`);
  if (row.expiresAt !== null && row.expiresAt.getTime() < Date.now()) {
    throw conflict(`Credential '${row.name}' has expired`);
  }
  await db.credential.update({ where: { id }, data: { lastUsedAt: new Date() } });
  await recordActivity(db, {
    actor: ctx.actor,
    action: "credential.reveal",
    targetType: "Credential",
    targetId: id,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    metadata: { scope: row.scope, refId: row.refId },
  });
  return vaultOpen(row.payload);
}

export async function findActiveCredential(
  db: DbClient,
  scope: string,
  refId: string,
): Promise<Credential | null> {
  const rows = await db.credential.findMany({
    where: { scope, refId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  for (const row of rows) {
    if (row.expiresAt === null || row.expiresAt.getTime() >= Date.now()) return row;
  }
  return null;
}

export async function listCredentials(db: DbClient, scope?: string): Promise<Credential[]> {
  return db.credential.findMany({
    where: scope !== undefined ? { scope } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}
