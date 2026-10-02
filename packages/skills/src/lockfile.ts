/**
 * Skill lockfile (agentworld.skills.lock).
 *
 * Records exactly what was installed, from where, at which version and
 * hash, so an environment can reproduce the same skill set. Verification
 * compares the live catalog against the lock without mutating anything.
 */
import { z } from "zod";

export const SkillLockEntrySchema = z.object({
  source: z.string().min(1).max(40),
  sourceIdentifier: z.string().min(1).max(500),
  version: z.string().min(1).max(60),
  integrity: z.string().min(1).max(128),
  dependencies: z.array(z.string().max(160)).max(50).default([]),
  permissions: z.array(z.string().max(120)).max(100).default([]),
  capabilities: z.array(z.string().max(120)).max(100).default([]),
  installedAt: z.string().min(1).max(40),
});
export type SkillLockEntry = z.infer<typeof SkillLockEntrySchema>;

export const SkillLockfileSchema = z.object({
  version: z.literal(1),
  skills: z.record(z.string(), SkillLockEntrySchema),
});
export type SkillLockfile = z.infer<typeof SkillLockfileSchema>;

export function buildLockfile(
  entries: Array<{
    key: string;
    source: string;
    sourceIdentifier: string;
    version: string;
    integrity: string;
    dependencies: string[];
    permissions: string[];
    capabilities: string[];
    installedAt: string;
  }>,
): SkillLockfile {
  const skills: Record<string, SkillLockEntry> = {};
  for (const e of entries) {
    skills[e.key] = {
      source: e.source,
      sourceIdentifier: e.sourceIdentifier,
      version: e.version,
      integrity: e.integrity,
      dependencies: [...e.dependencies],
      permissions: [...e.permissions],
      capabilities: [...e.capabilities],
      installedAt: e.installedAt,
    };
  }
  return { version: 1, skills };
}

export function parseLockfile(raw: unknown): SkillLockfile {
  return SkillLockfileSchema.parse(raw);
}

export interface LockDrift {
  key: string;
  kind: "MISSING" | "VERSION_MISMATCH" | "INTEGRITY_MISMATCH";
  message: string;
}

/** Compare a lockfile against live state. Pure; never writes. */
export function verifyLockfile(
  lock: SkillLockfile,
  live: Map<string, { version: string; integrity: string }>,
): LockDrift[] {
  const drifts: LockDrift[] = [];
  for (const [key, entry] of Object.entries(lock.skills)) {
    const current = live.get(key);
    if (current === undefined) {
      drifts.push({ key, kind: "MISSING", message: `Skill '${key}' is locked but not installed` });
      continue;
    }
    if (current.version !== entry.version) {
      drifts.push({
        key,
        kind: "VERSION_MISMATCH",
        message: `Skill '${key}' is ${current.version} but lock pins ${entry.version}`,
      });
    }
    if (current.integrity !== entry.integrity) {
      drifts.push({
        key,
        kind: "INTEGRITY_MISMATCH",
        message: `Skill '${key}' content hash differs from lock (possible unapproved modification)`,
      });
    }
  }
  return drifts;
}
