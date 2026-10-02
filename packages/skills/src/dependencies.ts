/**
 * Dependency resolution.
 *
 * Resolves Skill A -> B -> C, reporting missing, incompatible, circular,
 * dangerous, and untrusted dependencies. Never silently installs
 * privileged dependencies; every edge is explicit.
 */
import { satisfiesRange } from "./validator.js";
import type { SkillManifest, TrustLevel } from "./types.js";

export interface DependencyIssue {
  kind: "MISSING" | "INCOMPATIBLE" | "CIRCULAR" | "DANGEROUS" | "UNTRUSTED";
  dependency: string;
  message: string;
}

export interface DependencyResolution {
  ok: boolean;
  order: string[];
  issues: DependencyIssue[];
}

const DANGEROUS_DEP_PATTERN = /^(http|eval|exec|sudo|rm\s)/i;

export function resolveDependencies(
  root: SkillManifest,
  available: Map<string, SkillManifest>,
  trustOf?: (key: string) => TrustLevel | undefined,
): DependencyResolution {
  const issues: DependencyIssue[] = [];
  const order: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (manifest: SkillManifest): void => {
    if (stack.includes(manifest.key)) {
      const cycle = [...stack.slice(stack.indexOf(manifest.key)), manifest.key].join(" -> ");
      issues.push({ kind: "CIRCULAR", dependency: manifest.key, message: `Circular dependency: ${cycle}` });
      return;
    }
    if (visited.has(manifest.key)) return;
    stack.push(manifest.key);
    for (const dep of manifest.dependencies) {
      if (DANGEROUS_DEP_PATTERN.test(dep.key) || dep.key.includes("..")) {
        issues.push({ kind: "DANGEROUS", dependency: dep.key, message: `Dependency '${dep.key}' looks dangerous` });
        continue;
      }
      const candidate = available.get(dep.key);
      if (candidate === undefined) {
        // The root's own key is always "available"; anything else missing is reported.
        if (dep.key !== root.key) {
          issues.push({ kind: "MISSING", dependency: dep.key, message: `Missing dependency '${dep.key}' required by '${manifest.key}'` });
        }
        continue;
      }
      if (!satisfiesRange(candidate.version, dep.versionRange)) {
        issues.push({
          kind: "INCOMPATIBLE",
          dependency: dep.key,
          message: `Dependency '${dep.key}@${candidate.version}' does not satisfy '${dep.versionRange ?? "*"}'`,
        });
        continue;
      }
      const trust = trustOf?.(dep.key);
      if (trust === "SUSPICIOUS" || trust === "BLOCKED") {
        issues.push({ kind: "UNTRUSTED", dependency: dep.key, message: `Dependency '${dep.key}' is ${trust}` });
        continue;
      }
      visit(candidate);
    }
    stack.pop();
    visited.add(manifest.key);
    order.push(manifest.key);
  };

  visit(root);
  return { ok: issues.length === 0, order, issues };
}
