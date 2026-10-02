/**
 * ExternalSkillSecurityAnalyzer.
 *
 * Treats every byte of external content as untrusted. Scans instructions,
 * file contents, declared permissions/tools, network policy, secrets, and
 * dependencies for shell, filesystem, network, secret, execution, and
 * prompt-injection signals. Produces a SecurityReport; never grants anything.
 */
import type { SkillManifest, SecurityReport, SecurityFinding, SkillRiskLevel } from "./types.js";

/** Permissions no external skill may silently receive. */
export const DANGEROUS_PERMISSIONS = [
  "wallet.transfer",
  "wallet.withdraw",
  "agent.create",
  "agent.delete",
  "agent.modify",
  "approval.decide",
  "company.structure.modify",
  "audit.read",
  "plan.approve",
  "workspace.admin",
  "workspace.delete",
  "workspace.execute",
] as const;

/** Human-only permissions an agent can never hold (mirrors security/permissions). */
export const HUMAN_ONLY_PERMISSIONS = [
  "approval.decide",
  "agent.create",
  "agent.delete",
  "agent.modify",
  "company.structure.modify",
  "audit.read",
  "wallet.withdraw",
  "plan.approve",
] as const;

interface Pattern {
  code: string;
  severity: SecurityFinding["severity"];
  message: string;
  regex: RegExp;
}

const CONTENT_PATTERNS: Pattern[] = [
  { code: "PROMPT_INJECTION", severity: "CRITICAL", message: "Prompt-injection: attempts to override system/security instructions", regex: /ignore\s+(all\s+)?(previous|prior|above|system)\s+instructions|ignore\s+agentworld\s+security|bypass\s+approval|disable\s+(safety|guardrail|security)/i },
  { code: "PROMPT_INJECTION", severity: "CRITICAL", message: "Prompt-injection: claims new privileged identity", regex: /you\s+are\s+now\s+(root|admin|system|owner)|act\s+as\s+(system|root)\b/i },
  { code: "APPROVAL_BYPASS", severity: "CRITICAL", message: "Attempts to bypass human approval", regex: /skip\s+approval|without\s+approval|auto-?approve|self-?approve/i },
  { code: "PERM_MODIFY", severity: "CRITICAL", message: "Attempts to modify its own permissions or role", regex: /grant\s+(me|itself)\s+.*permission|escalate\s+(my\s+)?privileges|widen\s+(my\s+)?permissions|modify\s+(my|its)\s+role/i },
  { code: "SECRET_ACCESS", severity: "HIGH", message: "Reads process secrets/environment", regex: /process\.env|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_SECRET|PRIVATE_KEY/i },
  { code: "ENV_DUMP", severity: "HIGH", message: "Dumps environment or credentials", regex: /\benv\b.*\b(print|dump|list|echo)\b|printenv|set\s*>\s*\/|\/proc\/self\/environ/i },
  { code: "CRED_EXFIL", severity: "CRITICAL", message: "Possible credential exfiltration channel", regex: /curl\s+.*(api_key|token|secret)|wget\s+.*(api_key|token|secret)|fetch\s*\(\s*['"`]https?:\/\/(?!example\.com)/i },
  { code: "SHELL_EXEC", severity: "HIGH", message: "Spawns a shell or evaluates code", regex: /\b(exec\s*\(|spawn\s*\(|execSync|child_process|shell\s*:\s*true|eval\s*\(|new\s+Function\s*\()/i },
  { code: "DYNAMIC_CODE", severity: "HIGH", message: "Dynamic code loading", regex: /\b(require\s*\(\s*[^'")]*\+|import\s*\(\s*[^'")]*\+|vm\.runIn|dangerouslySetInnerHTML)\b/i },
  { code: "FS_ROOT", severity: "HIGH", message: "Absolute filesystem access outside workspace", regex: /\/etc\/(passwd|shadow)|\/root\/|C:\\\\Windows|\\\\\.\.\\\\|\.\.\/\.\.\// },
  { code: "PATH_TRAVERSAL", severity: "HIGH", message: "Path traversal pattern", regex: /\.\.\/|%2e%2e|~\/|\$HOME/i },
  // eslint-disable-next-line no-useless-escape -- `\/` is the regex-literal delimiter here, not a useless escape.
  { code: "DESTRUCTIVE_CMD", severity: "CRITICAL", message: "Destructive command", regex: /\brm\s+-rf\s+\/|mkfs|:\(\)\s*\{\s*:\|\:|format\s+[a-z]:|del\s+\/[fsq].*\*/i },
  { code: "PRIV_ESCALATION", severity: "CRITICAL", message: "Privilege escalation attempt", regex: /\bsudo\b|\bsu\s+-|setuid|chmod\s+4755|runas\s+\/user/i },
  { code: "HIDDEN_EXEC", severity: "HIGH", message: "Hidden executable or install script", regex: /\.exe\b|\.sh\b.*curl|install\.sh|postinstall|preinstall/i },
  { code: "SUSPICIOUS_NETWORK", severity: "MEDIUM", message: "Undeclared outbound network reference", regex: /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i },
  { code: "INSTALL_SCRIPT", severity: "MEDIUM", message: "Runs dependency installation at install time", regex: /\bnpm\s+(install|i)\b|\bpip\s+install\b|\bcargo\s+add\b|go\s+get\b/i },
];

const KNOWN_EXFIL_DOMAINS = ["discord.com", "webhook.site", "ngrok.io", "pastebin.com"];

export function analyzeExternalSkill(
  manifest: SkillManifest,
  fileContents: Record<string, string> = {},
): SecurityReport {
  const findings: SecurityFinding[] = [];
  const push = (code: string, severity: SecurityFinding["severity"], message: string, file?: string, evidence?: string): void => {
    findings.push({
      code,
      severity,
      message,
      ...(file !== undefined ? { file } : {}),
      ...(evidence !== undefined ? { evidence: evidence.slice(0, 500) } : {}),
    });
  };

  const haystacks: Array<{ label: string; text: string }> = [
    { label: "instructions", text: manifest.instructions },
    { label: "manifest", text: JSON.stringify({ permissions: manifest.permissions, tools: manifest.tools, network: manifest.network, secrets: manifest.secretRequirements }) },
  ];
  for (const [name, content] of Object.entries(fileContents)) {
    haystacks.push({ label: name, text: content });
  }

  for (const { label, text } of haystacks) {
    if (text.trim() === "") continue;
    for (const pattern of CONTENT_PATTERNS) {
      // SUSPICIOUS_NETWORK is only meaningful when network access is undeclared.
      if (pattern.code === "SUSPICIOUS_NETWORK" && manifest.network.access === true) continue;
      const match = pattern.regex.exec(text);
      if (match !== null) {
        push(pattern.code, pattern.severity, `${pattern.message} (${label})`, label, match[0]);
      }
    }
    for (const domain of KNOWN_EXFIL_DOMAINS) {
      if (text.toLowerCase().includes(domain)) {
        push("CRED_EXFIL", "CRITICAL", `References known exfiltration domain ${domain} (${label})`, label, domain);
      }
    }
  }

  // Declared-permission analysis: dangerous + human-only + excessive.
  for (const perm of manifest.permissions) {
    if ((DANGEROUS_PERMISSIONS as readonly string[]).includes(perm)) {
      push("EXCESSIVE_PERMS", "HIGH", `Requests dangerous permission '${perm}': requires explicit human review`, undefined, perm);
    }
    if ((HUMAN_ONLY_PERMISSIONS as readonly string[]).includes(perm)) {
      push("PRIV_ESCALATION", "CRITICAL", `Requests human-only permission '${perm}': an agent can never hold this`, undefined, perm);
    }
  }
  if (manifest.permissions.includes("*")) {
    push("EXCESSIVE_PERMS", "CRITICAL", "Requests wildcard '*' permissions", undefined, "*");
  }
  if (manifest.tools.includes("*")) {
    push("EXCESSIVE_PERMS", "HIGH", "Requests wildcard '*' tools", undefined, "*");
  }

  // Secret handling: declared secrets are fine; undeclared env reads are not.
  if (manifest.secretRequirements.length > 0) {
    findings.push({
      code: "SECRET_REQUIREMENT",
      severity: "MEDIUM",
      message: `Declares secret requirements (${manifest.secretRequirements.join(", ")}): must use server-side secret handling, never prompts/logs`,
    });
  }

  // Network policy: unrestricted access is a finding.
  if (manifest.network.access === true && manifest.network.domains.length === 0) {
    push("SUSPICIOUS_NETWORK", "HIGH", "Requests unrestricted network access with no domain allowlist");
  }

  // Dependencies: suspicious specifiers.
  for (const dep of manifest.dependencies) {
    if (dep.key.startsWith("http://") || dep.key.startsWith("https://")) {
      push("MALICIOUS_DEP", "HIGH", `Dependency '${dep.key}' is a raw URL`, undefined, dep.key);
    }
    if (dep.key.includes("..") || dep.key.includes("//")) {
      push("MALICIOUS_DEP", "HIGH", `Dependency '${dep.key}' looks like path traversal`, undefined, dep.key);
    }
  }

  const riskLevel = riskFromFindings(findings);
  const recommendations: string[] = [];
  if (findings.some((f) => f.severity === "CRITICAL")) {
    recommendations.push("Block installation until all CRITICAL findings are resolved and re-reviewed by a human.");
  }
  if (findings.some((f) => f.code === "EXCESSIVE_PERMS")) {
    recommendations.push("Down-scope capabilities: install with the minimal permission subset and deny the rest.");
  }
  if (manifest.network.access === true) {
    recommendations.push("Constrain network to an explicit domain allowlist; deny by default.");
  }
  if (manifest.secretRequirements.length > 0) {
    recommendations.push("Bind secrets server-side; never inject them into prompts, logs, or terminal output.");
  }
  if (recommendations.length === 0) {
    recommendations.push("No blocking issues. Standard review still required before enabling for agents.");
  }

  return {
    riskLevel,
    findings,
    requestedCapabilities: [...manifest.capabilities],
    requestedPermissions: [...manifest.permissions],
    requestedTools: [...manifest.tools],
    recommendations,
    scannedAt: new Date().toISOString(),
  };
}

function riskFromFindings(findings: SecurityFinding[]): SkillRiskLevel {
  if (findings.some((f) => f.severity === "CRITICAL")) return "CRITICAL";
  if (findings.some((f) => f.severity === "HIGH")) return "HIGH";
  if (findings.some((f) => f.severity === "MEDIUM")) return "MEDIUM";
  return "LOW";
}

export function blocksInstallation(report: SecurityReport): boolean {
  return report.riskLevel === "CRITICAL";
}

export function requiresHumanReview(report: SecurityReport): boolean {
  return report.riskLevel === "HIGH" || report.riskLevel === "CRITICAL" || report.findings.length > 0;
}
