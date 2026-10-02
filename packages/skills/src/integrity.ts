/**
 * Integrity: checksums / hashes / revision pinning.
 *
 * Where supported, the installed content hash is recorded at install time.
 * If content changes without a valid update, the skill is marked MODIFIED
 * and execution must be gated by policy.
 */
import { createHash } from "node:crypto";
import type { SkillManifest } from "./types.js";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function manifestHash(manifest: SkillManifest): string {
  return sha256Hex(canonicalJson(manifest));
}

export function contentHash(files: Record<string, string>): string {
  const names = Object.keys(files).sort();
  const h = createHash("sha256");
  for (const name of names) {
    h.update(name, "utf8").update("\0", "utf8").update(files[name] ?? "", "utf8").update("\0", "utf8");
  }
  return h.digest("hex");
}

export function skillIntegrityHash(manifest: SkillManifest, files: Record<string, string> = {}): string {
  return sha256Hex(`${manifestHash(manifest)}:${contentHash(files)}`);
}

export function verifyIntegrity(expected: string, manifest: SkillManifest, files: Record<string, string> = {}): boolean {
  return timingSafeEqualHex(expected, skillIntegrityHash(manifest, files));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a.charCodeAt(i) ^ (b.charCodeAt(i) ?? 0));
  }
  return diff === 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
