/**
 * Trust model.
 *
 * SYSTEM > VERIFIED > TRUSTED_EXTERNAL > UNVERIFIED > SUSPICIOUS > BLOCKED.
 * Trust NEVER grants permissions; it only records how much review a skill
 * has survived. The permission/approval layers decide what may run.
 */
import type { SecurityReport, TrustLevel } from "./types.js";
import type { SkillSourceType } from "./sources.js";

const TRUST_RANK: Record<TrustLevel, number> = {
  SYSTEM: 0,
  VERIFIED: 1,
  TRUSTED_EXTERNAL: 2,
  UNVERIFIED: 3,
  SUSPICIOUS: 4,
  BLOCKED: 5,
};

export function trustRank(level: TrustLevel): number {
  return TRUST_RANK[level];
}

export function higherTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return trustRank(a) <= trustRank(b) ? a : b;
}

export interface TrustInput {
  sourceType: SkillSourceType;
  explicitlyVerified: boolean;
  explicitlyBlocked: boolean;
  report: SecurityReport;
}

/**
 * Evaluate trust for an external skill. External content starts UNVERIFIED
 * and can only rise to TRUSTED_EXTERNAL when validation passed (caller
 * ensures this) AND the security report is clean enough. CRITICAL findings
 * force SUSPICIOUS/BLOCKED; an explicit blocklist always wins.
 */
export function evaluateTrust(input: TrustInput): TrustLevel {
  if (input.explicitlyBlocked || input.report.riskLevel === "CRITICAL") {
    const hasInjection = input.report.findings.some(
      (f) => f.code === "PROMPT_INJECTION" || f.code === "CRED_EXFIL" || f.code === "PRIV_ESCALATION",
    );
    return hasInjection || input.explicitlyBlocked ? "BLOCKED" : "SUSPICIOUS";
  }
  if (input.sourceType === "SYSTEM") return "SYSTEM";
  if (input.sourceType === "AGENTWORLD") return "VERIFIED";
  if (input.explicitlyVerified && input.report.riskLevel !== "HIGH") return "VERIFIED";
  if (input.report.riskLevel === "HIGH") return "SUSPICIOUS";
  if (input.report.riskLevel === "MEDIUM" || input.report.riskLevel === "LOW") return "TRUSTED_EXTERNAL";
  return "UNVERIFIED";
}

/** Trust precedence when two skills claim the same key. Lower wins. */
export function trustPriority(level: TrustLevel): number {
  return trustRank(level);
}

/** An external skill must never silently override a trusted native skill. */
export function mayOverride(candidateTrust: TrustLevel, incumbentTrust: TrustLevel): boolean {
  return trustRank(candidateTrust) <= trustRank(incumbentTrust);
}
