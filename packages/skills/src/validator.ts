/**
 * Manifest + version + dependency validation.
 *
 * Validation answers "is this well-formed and internally consistent".
 * Danger is answered separately by the security analyzer; a well-formed
 * skill can still be SUSPICIOUS or BLOCKED.
 */
import { SkillManifestSchema, type SkillManifest } from "./types.js";

const VERSION_RE = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const DOTTED_RE = /^[a-z0-9]+(\.[a-z0-9-_]+)+$/;
const SECRET_RE = /^[A-Z][A-Z0-9_]*$/;

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  manifest: SkillManifest | null;
}

export function validateManifest(raw: unknown): ValidationResult {
  const parsed = SkillManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
      manifest: null,
    };
  }
  const issues: ValidationIssue[] = [];
  const m = parsed.data;

  if (!VERSION_RE.test(m.version.trim())) {
    issues.push({ path: "version", message: `Version '${m.version}' is not semver (expected X.Y.Z)` });
  }
  const seenDeps = new Set<string>();
  for (const dep of m.dependencies) {
    if (seenDeps.has(dep.key)) {
      issues.push({ path: "dependencies", message: `Duplicate dependency '${dep.key}'` });
    }
    seenDeps.add(dep.key);
    if (dep.key === m.key) {
      issues.push({ path: "dependencies", message: "Skill must not depend on itself" });
    }
  }
  for (const perm of m.permissions) {
    if (!DOTTED_RE.test(perm) && perm !== "*") {
      issues.push({ path: "permissions", message: `Permission '${perm}' must be dotted lowercase (e.g. 'filesystem.read')` });
    }
  }
  for (const tool of m.tools) {
    if (!DOTTED_RE.test(tool) && tool !== "*") {
      issues.push({ path: "tools", message: `Tool '${tool}' must be dotted lowercase (e.g. 'browser.navigate')` });
    }
  }
  for (const secret of m.secretRequirements) {
    if (!SECRET_RE.test(secret)) {
      issues.push({ path: "secretRequirements", message: `Secret '${secret}' must look like ENV_VAR_NAME` });
    }
  }
  if (m.network.access === false && m.network.domains.length > 0) {
    issues.push({ path: "network", message: "Domains listed but network.access is false" });
  }
  for (const file of m.files) {
    if (file.path.includes("..") || file.path.startsWith("/") || file.path.startsWith("\\")) {
      issues.push({ path: "files", message: `File path '${file.path}' must be relative without traversal` });
    }
  }
  return { valid: issues.length === 0, issues, manifest: issues.length === 0 ? m : null };
}

export function validateVersionCompatibility(manifest: SkillManifest, hostVersion: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (manifest.minCompatibleVersion !== undefined && compareVersions(hostVersion, manifest.minCompatibleVersion) < 0) {
    issues.push({
      path: "minCompatibleVersion",
      message: `Host ${hostVersion} is below minimum ${manifest.minCompatibleVersion}`,
    });
  }
  if (manifest.maxCompatibleVersion !== undefined && compareVersions(hostVersion, manifest.maxCompatibleVersion) > 0) {
    issues.push({
      path: "maxCompatibleVersion",
      message: `Host ${hostVersion} is above maximum ${manifest.maxCompatibleVersion}`,
    });
  }
  return issues;
}

/** Compare dot-separated numeric versions. Returns -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a);
  const pb = normalizeVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function normalizeVersion(v: string): number[] {
  return v
    .trim()
    .replace(/^v/, "")
    .split(/[-+]/)[0]
    ?.split(".")
    .map((s) => Number.parseInt(s, 10))
    .map((n) => (Number.isFinite(n) && n >= 0 ? n : 0)) ?? [];
}

/** Minimal range check: "*", "1.2.3", "^1.2.0", "~1.2.0", ">=1.2.0". */
export function satisfiesRange(version: string, range: string | undefined): boolean {
  if (range === undefined || range.trim() === "" || range.trim() === "*") return true;
  const r = range.trim();
  if (r.startsWith("^")) {
    const base = r.slice(1);
    const parts = normalizeVersion(base);
    const major = parts[0] ?? 0;
    return (
      compareVersions(version, base) >= 0 &&
      (major > 0 ? compareVersions(version, `${major + 1}.0.0`) < 0 : compareVersions(version, "1.0.0") < 0)
    );
  }
  if (r.startsWith("~")) {
    const base = r.slice(1);
    const parts = normalizeVersion(base);
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    return compareVersions(version, base) >= 0 && compareVersions(version, `${major}.${minor + 1}.0`) < 0;
  }
  if (r.startsWith(">=")) return compareVersions(version, r.slice(2).trim()) >= 0;
  if (r.startsWith("=")) return compareVersions(version, r.slice(1).trim()) === 0;
  return compareVersions(version, r) === 0;
}
