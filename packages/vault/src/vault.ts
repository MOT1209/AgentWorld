/**
 * Credential vault.
 *
 * The single place that turns plaintext secrets into storable ciphertext and
 * back. Rules:
 *
 *  - AES-256-GCM with a key derived (scrypt) from VAULT_MASTER_KEY, bound to
 *    a key version so rotation is possible without re-encrypting history.
 *  - A development fallback key is derived from a stable dev constant so a
 *    fresh clone still runs; PRODUCTION REQUIRES an explicit master key and
 *    refuses to seal or open anything without one.
 *  - Sealed payloads are self-describing JSON `{ v, iv, tag, data }` (base64),
 *    which is what the Credential.payload column stores.
 *  - Plaintext never appears in logs: the only surface that returns it is
 *    `open()`, called by server-side code paths that inject the secret into an
 *    outbound request. DTOs and prompts receive metadata only.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getConfig } from "../../shared/src/config.js";
import { conflict, forbidden, validationError } from "../../shared/src/index.js";

const KEY_VERSION = 1;
const KEY_LENGTH = 32;

const DEV_FALLBACK_SALT = "kingworld-dev-vault-salt-v1";

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey !== null) return cachedKey;
  const configured = getConfig().vault.masterKey;
  if (configured !== "") {
    cachedKey = scryptSync(configured, "kingworld-vault-v1", KEY_LENGTH);
    return cachedKey;
  }
  if (getConfig().isProduction) {
    throw forbidden("VAULT_MASTER_KEY must be set in production before any credential is sealed or read");
  }
  // Stable dev fallback: deterministic across restarts so dev data survives,
  // clearly not for production (config refuses the placeholder there).
  cachedKey = scryptSync(`dev:${DEV_FALLBACK_SALT}`, "kingworld-vault-dev", KEY_LENGTH);
  return cachedKey;
}

/** Test hook: drops the derived key so a new env var takes effect. */
export function resetVaultKeyCache(): void {
  cachedKey = null;
}

export interface SealedPayload {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

export function seal(plaintext: string): { payload: string; keyVersion: number } {
  if (plaintext.length === 0) throw validationError("Cannot seal an empty secret");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const sealed: SealedPayload = {
    v: KEY_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return { payload: JSON.stringify(sealed), keyVersion: KEY_VERSION };
}

export function open(payload: string): string {
  let parsed: SealedPayload;
  try {
    parsed = JSON.parse(payload) as SealedPayload;
  } catch {
    throw conflict("Credential payload is corrupt");
  }
  if (parsed.v !== KEY_VERSION || typeof parsed.iv !== "string" || typeof parsed.tag !== "string" || typeof parsed.data !== "string") {
    throw conflict(`Credential payload key version ${String(parsed.v)} is not readable by vault key version ${KEY_VERSION}`);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered payload -- never distinguish which from outside.
    throw forbidden("Credential payload failed authentication");
  }
}

/** Constant-time string compare for token checks. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Non-secret shape every external surface uses. */
export interface CredentialMetadata {
  keyVersion: number;
  kind: string;
  scope: string;
  refId: string;
  status: string;
}
