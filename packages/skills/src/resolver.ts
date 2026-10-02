/**
 * Skill resolver: which record wins, and may an agent use it.
 *
 * Source priority prevents a silent override: an external skill never
 * replaces a trusted native skill with the same key unless its trust is
 * equal or higher. Assignment checks (compatibility, capability,
 * permission, policy) are pure so routes and the delegation engine share
 * one implementation.
 */
import { sourcePriority } from "./sources.js";
import { trustPriority, mayOverride } from "./trust.js";
import type { SkillCatalogRecord } from "./types.js";

export function resolveSkillWinner(candidates: SkillCatalogRecord[]): SkillCatalogRecord | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const trustDiff = trustPriority(a.trust) - trustPriority(b.trust);
    if (trustDiff !== 0) return trustDiff;
    return sourcePriority(a.source.type) - sourcePriority(b.source.type);
  })[0] ?? null;
}

export function canReplaceSkill(incumbent: SkillCatalogRecord, candidate: SkillCatalogRecord): boolean {
  if (incumbent.key !== candidate.key) return true;
  return mayOverride(candidate.trust, incumbent.trust);
}

export interface AssignmentContext {
  roleKey: string;
  roleCapabilities: string[];
  rolePermissions: string[];
  skill: SkillCatalogRecord;
}

export interface AssignmentVerdict {
  compatible: boolean;
  reasons: string[];
}

/** Assignment must pass compatibility + capability + permission + policy. */
export function checkAssignmentCompatibility(ctx: AssignmentContext): AssignmentVerdict {
  const reasons: string[] = [];
  const skill = ctx.skill;
  if (skill.trust === "BLOCKED" || skill.status === "BLOCKED") {
    reasons.push("Skill is BLOCKED and cannot be assigned.");
  }
  if (!skill.installed || !skill.enabled) {
    reasons.push("Skill must be installed and enabled before assignment.");
  }
  if (skill.compatibility === "BLOCKED" || skill.compatibility === "UNSUPPORTED") {
    reasons.push(`Skill compatibility is ${skill.compatibility}: ${skill.compatibilityReason ?? "unsupported"}.`);
  }
  const manifest = skill.manifest;
  if (manifest === null) {
    reasons.push("Skill has no validated manifest.");
  } else {
    const missingCapabilities = manifest.capabilities.filter((c) => !ctx.roleCapabilities.includes(c));
    if (missingCapabilities.length > 0 && !ctx.roleCapabilities.includes("general")) {
      reasons.push(`Role '${ctx.roleKey}' lacks capabilities: ${missingCapabilities.join(", ")}.`);
    }
    const missingPermissions = manifest.permissions.filter((p) => !ctx.rolePermissions.includes(p));
    if (missingPermissions.length > 0) {
      reasons.push(
        `Role '${ctx.roleKey}' lacks permissions for this skill: ${missingPermissions.join(", ")}. ` +
          `Grant them explicitly or down-scope the install.`,
      );
    }
  }
  return { compatible: reasons.length === 0, reasons };
}

export interface SkillRequest {
  id: string;
  skillKey: string;
  agentId: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decidedByUserId: string | null;
  createdAt: string;
}

/** An agent may request a skill but can never approve its own request. */
export function decideSkillRequest(
  request: SkillRequest,
  decision: "APPROVED" | "REJECTED",
  decider: { userId: string; isAgent: boolean },
): SkillRequest {
  if (decider.isAgent) throw new Error("Agents cannot approve their own skill requests.");
  if (request.status !== "PENDING") throw new Error(`Skill request is already ${request.status}.`);
  return { ...request, status: decision, decidedByUserId: decider.userId };
}
