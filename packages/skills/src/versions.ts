/**
 * Version management: install / update / rollback / pin / disable.
 *
 * Never auto-updates during an active execution (the caller holds the
 * execution gate). Updates that widen permissions or capabilities always
 * require explicit review; the diff is computed here so the UI can show it.
 */
import { compareVersions } from "./validator.js";
import type { SkillManifest } from "./types.js";

export interface VersionDiff {
  fromVersion: string;
  toVersion: string;
  addedPermissions: string[];
  removedPermissions: string[];
  addedCapabilities: string[];
  removedCapabilities: string[];
  addedTools: string[];
  removedTools: string[];
  /** True when the update widens authority and must be re-approved. */
  widensAuthority: boolean;
}

export function diffVersions(from: SkillManifest, to: SkillManifest): VersionDiff {
  const addedPermissions = to.permissions.filter((p) => !from.permissions.includes(p));
  const removedPermissions = from.permissions.filter((p) => !to.permissions.includes(p));
  const addedCapabilities = to.capabilities.filter((c) => !from.capabilities.includes(c));
  const removedCapabilities = from.capabilities.filter((c) => !to.capabilities.includes(c));
  const addedTools = to.tools.filter((t) => !from.tools.includes(t));
  const removedTools = from.tools.filter((t) => !to.tools.includes(t));
  return {
    fromVersion: from.version,
    toVersion: to.version,
    addedPermissions,
    removedPermissions,
    addedCapabilities,
    removedCapabilities,
    addedTools,
    removedTools,
    widensAuthority: addedPermissions.length > 0 || addedCapabilities.length > 0 || addedTools.length > 0,
  };
}

export function isNewerVersion(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) > 0;
}

export interface VersionRecord {
  version: string;
  integrityHash: string;
  manifest: SkillManifest;
  installedAt: string;
}

/** Keep the last N verified versions so rollback can restore one. */
export function pushVersionHistory(
  history: VersionRecord[],
  record: VersionRecord,
  maxEntries = 5,
): VersionRecord[] {
  const next = [...history.filter((h) => h.version !== record.version), record].sort((a, b) =>
    compareVersions(a.version, b.version),
  );
  return next.slice(Math.max(0, next.length - maxEntries));
}

export function findRollbackTarget(history: VersionRecord[], currentVersion: string): VersionRecord | null {
  const older = history
    .filter((h) => compareVersions(h.version, currentVersion) < 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return older[0] ?? null;
}
