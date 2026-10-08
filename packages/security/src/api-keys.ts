/**
 * Public API keys -- how external applications (and the MCP server) call in.
 *
 * Storage rules:
 *  - Only `sha256(plaintext)` is stored (`keyHash`), with a display `prefix`
 *    so an operator can identify a key without ever seeing the secret.
 *  - The plaintext is returned exactly once, at creation. Nothing else in the
 *    system can recover it.
 *  - Scopes are permission names validated against the catalogue; a key can
 *    never hold a permission its creating owner does not have (least
 *    privilege, no self-escalation).
 *  - Expiry and revocation are enforced at authenticate time.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DbClient } from "../../database/src/index.js";
import type { ApiKey } from "../../database/src/types.js";
import { ALL_PERMISSIONS, isPermission, type Permission } from "./permissions.js";
import { conflict, forbidden, notFound, toJson, validationError } from "../../shared/src/index.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { newCorrelationId, type ActorRef } from "../../shared/src/index.js";

const PREFIX_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Binds a presented key to a stable hash without leaking the key itself. */
export function apiKeyFingerprint(plaintext: string): string {
  return hashApiKey(`fp:${plaintext}`).slice(0, 16);
}

export function parseApiKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  const raw = bearer !== null ? (bearer[1] as string) : trimmed;
  if (!raw.startsWith("aw_")) return null;
  if (raw.length < 12 || raw.length > 200) return null;
  return raw;
}

export interface CreateApiKeyInput {
  name: string;
  scopes: string[];
  userId: string;
  /** Owner permission set; the key can never exceed it. */
  ownerPermissions: ReadonlySet<string>;
  ttlHours?: number | null;
}

export interface ApiKeyCreated {
  apiKey: ApiKey;
  /** Plaintext secret -- returned exactly once. */
  secret: string;
}

export async function createApiKey(
  db: DbClient,
  input: CreateApiKeyInput,
  ctx: { actor: ActorRef; correlationId?: string },
): Promise<ApiKeyCreated> {
  if (input.name.trim().length < 2) throw validationError("API key name must be at least 2 characters");
  const invalid = input.scopes.filter((scope) => !isPermission(scope));
  if (invalid.length > 0) {
    throw validationError(`Unknown scopes: ${invalid.join(", ")}`, {
      allowed: ALL_PERMISSIONS as readonly string[],
    });
  }
  const escalated = input.scopes.filter((scope) => !input.ownerPermissions.has(scope));
  if (escalated.length > 0) {
    throw forbidden("API key scopes must be a subset of the creator's permissions", {
      escalated,
    });
  }

  const body = randomBytes(24).toString("base64url");
  const suffix = Array.from(randomBytes(4))
    .map((byte) => PREFIX_ALPHABET[byte % PREFIX_ALPHABET.length])
    .join("");
  const prefix = `aw_${suffix}`;
  const secret = `${prefix}_${body}`;

  const row = await db.apiKey.create({
    data: {
      name: input.name.trim(),
      prefix,
      keyHash: hashApiKey(secret),
      scopes: toJson(input.scopes),
      userId: input.userId,
      status: "ACTIVE",
      ...(input.ttlHours !== undefined && input.ttlHours !== null
        ? { expiresAt: new Date(Date.now() + input.ttlHours * 3_600_000) }
        : {}),
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.APIKEY_CREATED,
    actor: ctx.actor,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "ApiKey",
    targetId: row.id,
    payload: { apiKeyId: row.id, name: row.name, prefix: row.prefix, userId: row.userId },
  });

  return { apiKey: row, secret };
}

export interface ApiKeyAuthentication {
  apiKey: ApiKey;
  scopes: ReadonlySet<Permission>;
}

/**
 * Verifies a presented key. Returns null for unknown/expired/revoked keys so
 * the caller maps every failure to the same 401 (no oracle).
 */
export async function authenticateApiKey(
  db: DbClient,
  secret: string,
): Promise<ApiKeyAuthentication | null> {
  const keyHash = hashApiKey(secret);
  const row = await db.apiKey.findUnique({ where: { keyHash } });
  if (row === null || row.status !== "ACTIVE") return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() < Date.now()) return null;

  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes) as unknown;
    if (Array.isArray(parsed)) scopes = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return null;
  }
  if (scopes.length === 0) return null;

  // Fire-and-forget usage stamp; never blocks or fails authentication.
  void db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return { apiKey: row, scopes: new Set(scopes.filter(isPermission)) };
}

export async function revokeApiKey(
  db: DbClient,
  id: string,
  ctx: { actor: ActorRef; correlationId?: string },
): Promise<ApiKey> {
  const row = await db.apiKey.findUnique({ where: { id } });
  if (row === null) throw notFound("ApiKey", id);
  if (row.status === "REVOKED") return row;
  const updated = await db.apiKey.update({
    where: { id },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.APIKEY_REVOKED,
    actor: ctx.actor,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "ApiKey",
    targetId: id,
    payload: { apiKeyId: id, name: row.name },
  });
  return updated;
}

export function apiKeyMetadata(row: ApiKey): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    status: row.status,
    scopes: safeScopes(row.scopes),
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function safeScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export async function listApiKeys(db: DbClient, userId?: string): Promise<ApiKey[]> {
  return db.apiKey.findMany({
    where: userId !== undefined ? { userId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export function assertScopesAllow(auth: ApiKeyAuthentication, permission: Permission): void {
  if (!auth.scopes.has(permission)) {
    throw forbidden(`API key lacks the required scope '${permission}'`);
  }
}

export { conflict };
