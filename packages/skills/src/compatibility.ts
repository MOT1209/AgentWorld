/**
 * skills.sh compatibility classification.
 *
 * Not every external skill can run inside AgentWorld. Classification is
 * explicit and always carries a reason so the UI can explain WHY a skill
 * cannot be installed instead of failing silently.
 */
import type { SkillCompatibility, SkillManifest, SecurityReport } from "./types.js";

export interface CompatibilityVerdict {
  compatibility: SkillCompatibility;
  reason: string;
}

const NATIVE_TOOL_PREFIXES = [
  "task.",
  "message.",
  "memory.",
  "wallet.",
  "world.",
  "company.",
  "event.",
  "approval.",
  "plan.",
  "review.",
  "report.",
  "agent.",
  "session.",
  "workspace.",
  "terminal.",
  "fs.",
  "git.",
];

const KNOWN_RUNTIMES = ["node", "python", "opencode", "local", "mock", "agentworld"];

export function classifyCompatibility(manifest: SkillManifest, report: SecurityReport): CompatibilityVerdict {
  if (report.riskLevel === "CRITICAL") {
    return { compatibility: "BLOCKED", reason: "Security report is CRITICAL; installation is blocked." };
  }
  const runtime = (manifest.runtime ?? "").toLowerCase();
  if (runtime !== "" && !KNOWN_RUNTIMES.includes(runtime)) {
    return {
      compatibility: "UNSUPPORTED",
      reason: `Runtime '${manifest.runtime}' is not supported by this AgentWorld (known: ${KNOWN_RUNTIMES.join(", ")}).`,
    };
  }
  const unknownTools = manifest.tools.filter(
    (t) => t !== "*" && !NATIVE_TOOL_PREFIXES.some((p) => t.startsWith(p)),
  );
  if (manifest.network.access === true && manifest.network.domains.length === 0) {
    return {
      compatibility: "REQUIRES_RUNTIME",
      reason: "Skill needs unrestricted network access; it can only run in an isolated runtime with an explicit allowlist.",
    };
  }
  if (unknownTools.length > 0 && manifest.tools.length > 3) {
    return {
      compatibility: "ADAPTABLE",
      reason: `Skill references ${unknownTools.length} non-native tool(s) (${unknownTools.slice(0, 3).join(", ")}); an adapter is required.`,
    };
  }
  if (unknownTools.length > 0) {
    return {
      compatibility: "ADAPTABLE",
      reason: `Skill references non-native tool(s) (${unknownTools.slice(0, 3).join(", ")}); review the adapter mapping before enabling.`,
    };
  }
  return { compatibility: "NATIVE_COMPATIBLE", reason: "Skill maps to native AgentWorld tools and policies." };
}
