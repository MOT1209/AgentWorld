/**
 * Command policy — ALLOW | DENY | REQUIRE_APPROVAL per command.
 *
 * The executor never runs a shell: commands arrive as argv arrays, so
 * `;`, `&&`, `$()` and friends are inert data, never syntax. On top of
 * that structural guarantee this policy classifies intent:
 *
 *   - DENY: destructive or infrastructure-level commands. Refused outright
 *     with `forbidden` before anything spawns. Never approvable.
 *   - REQUIRE_APPROVAL: publishing and deployment-shaped commands. Held for
 *     a human through the normal approval flow (`approvalPolicy` hook).
 *   - ALLOW: everything else, still bounded by timeout, cwd lock, output
 *     caps, and the audit trail.
 *
 * Policies are data: workspaces may tighten them via `environment.policy`
 * (`{ deny: [...], approve: [...] }` matched against the binary name or the
 * full `binary + first-arg` head); they can never loosen the built-ins.
 */
import type { RiskLevel } from "../../shared/src/index.js";

export type CommandVerdict = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface CommandPolicyResult {
  verdict: CommandVerdict;
  reason: string;
  risk: RiskLevel;
}

export interface WorkspacePolicyOverride {
  deny?: string[];
  approve?: string[];
}

/** Matched against the whole command with word boundaries: `rm -rf /tmp/x`
 *  must NOT match a `rm -rf /` rule, while `rm -rf / --force` must. */
function matchesAny(argv: string[], patterns: readonly string[]): string | null {
  const full = argv
    .map((part) => part.toLowerCase())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (full === "") return null;
  for (const raw of patterns) {
    const pattern = raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (pattern === "") continue;
    if (full === pattern || full.startsWith(`${pattern} `) || full.startsWith(`${pattern}:`)) {
      return raw;
    }
  }
  return null;
}

/** Never approvable. Matched before anything else, built-ins first. */
const BUILT_IN_DENY = [
  "rm -rf /",
  "rm -rf ~",
  "mkfs",
  "dd",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "format",
  ":(){",
  "chmod -r",
  "chown -r /",
  "iptables",
  "setfacl",
] as const;

/** Publishing-shaped commands. Held for a human, never silently run. */
const BUILT_IN_APPROVE = [
  "git push",
  "gh release",
  "npm publish",
  "npm deploy",
  "vercel --prod",
  "vercel deploy --prod",
  "kubectl",
  "terraform apply",
  "terraform destroy",
  "docker push",
  "gh pr merge",
] as const;

export function evaluateCommand(argv: string[], override?: WorkspacePolicyOverride): CommandPolicyResult {
  if (argv.length === 0 || (argv[0] ?? "").trim() === "") {
    return { verdict: "DENY", reason: "Empty command.", risk: "CRITICAL" };
  }

  const customDeny = matchesAny(argv, override?.deny ?? []);
  if (customDeny !== null) {
    return { verdict: "DENY", reason: `Denied by workspace policy: '${customDeny}'.`, risk: "HIGH" };
  }
  const builtInDeny = matchesAny(argv, BUILT_IN_DENY);
  if (builtInDeny !== null) {
    return { verdict: "DENY", reason: `Destructive command '${builtInDeny}' is never allowed.`, risk: "CRITICAL" };
  }
  const customApprove = matchesAny(argv, override?.approve ?? []);
  if (customApprove !== null) {
    return {
      verdict: "REQUIRE_APPROVAL",
      reason: `Workspace policy requires human approval for '${customApprove}'.`,
      risk: "HIGH",
    };
  }
  const builtInApprove = matchesAny(argv, BUILT_IN_APPROVE);
  if (builtInApprove !== null) {
    return {
      verdict: "REQUIRE_APPROVAL",
      reason: `Publishing command '${builtInApprove}' requires human approval.`,
      risk: "HIGH",
    };
  }
  return { verdict: "ALLOW", reason: "Allowed within workspace bounds.", risk: "LOW" };
}

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization)/i;

/**
 * Environment an agent child process may see: the process allow-list plus
 * workspace-declared variables, minus anything shaped like a secret.
 * `PATH`/`SystemRoot` (Windows) and locale survive so toolchains work.
 */
export function filterEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = new Set(["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "LANG", "LC_ALL", "HOME", "USER"]);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!keep.has(key)) continue;
    if (SECRET_KEY_PATTERN.test(key)) continue;
    output[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    output[key] = value;
  }
  return output;
}
