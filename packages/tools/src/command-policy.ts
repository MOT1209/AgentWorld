/**
 * Command policy — ALLOW | DENY | REQUIRE_APPROVAL per command.
 *
 * The executor never runs a shell: commands arrive as argv arrays, so
 * `;`, `&&`, `$()` and friends are inert data, never syntax. On top of
 * that structural guarantee this policy classifies intent:
 *
 *   - DENY: destructive or infrastructure-level commands. Refused outright
 *     with `forbidden` before anything spawns. Never approvable.
 *   - REQUIRE_APPROVAL: publishing commands, commands not on the routine
 *     allow-list, anything whose arguments point outside the workspace, and
 *     interpreters running inline code instead of a workspace file. Held for
 *     a human through the normal approval flow (`approvalPolicy` hook).
 *   - ALLOW: a curated set of routine, workspace-bounded work, still bounded
 *     by timeout, cwd lock, output caps, and the audit trail. Unknown
 *     commands are held for approval — never guessed at.
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

/**
 * Approval patterns match as ordered tokens, not as a string prefix, so global
 * options in between cannot hide the verb: `git -C . push`, `git --no-pager
 * push` and `npm --registry x publish` all still match `git push` /
 * `npm publish`. Over-matching (e.g. `git commit -m push`) only adds a human
 * look, which is the safe direction.
 */
function matchesVerbs(argv: string[], patterns: readonly string[]): string | null {
  const lowered = argv.map((part) => part.toLowerCase());
  for (const raw of patterns) {
    const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
    const [bin, ...verbs] = words;
    if (bin === undefined || lowered[0] !== bin) continue;
    let cursor = 1;
    let ok = true;
    for (const verb of verbs) {
      const at = lowered.indexOf(verb, cursor);
      if (at === -1) {
        ok = false;
        break;
      }
      cursor = at + 1;
    }
    if (ok) return raw;
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
  // Fetch-and-run or network-reaching verbs: code from outside the workspace.
  "npx",
  "npm exec",
  "npm x",
  "pnpm dlx",
  "pnpm exec",
  "yarn dlx",
  "bunx",
  "git clone",
  "git fetch",
  "git pull",
  "git remote",
  "git submodule",
  "git config",
] as const;

/** `find` can run commands (-exec) or delete (-delete); `xargs` always runs one. */
const EXEC_CAPABLE_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf"]);

/**
 * Routine, workspace-bounded work that runs without a human: navigation and
 * reading, package managers, language runtimes (invoked with a file argument,
 * never inline code), build/test toolchains, and git (publishing subcommands
 * are caught by BUILT_IN_APPROVE first). Everything else — shells, network
 * fetchers, privilege escalators, package managers' unknown verbs — is
 * unknown by default and held for approval.
 */
const BUILT_IN_SAFE = new Set([
  "ls", "dir", "pwd", "echo", "whoami", "date", "uname", "hostname",
  "type", "wc", "head", "tail", "sort", "uniq", "grep", "find", "which",
  "where", "cat", "mkdir", "touch", "cp", "mv",
  "node", "python", "python3", "npm", "npx", "yarn", "pnpm", "bun", "deno",
  "go", "cargo", "make", "tsc", "vitest", "jest", "eslint", "prettier",
  "pytest", "pip", "pip3", "uv", "git",
]);

/** Runtimes that accept code as an argument rather than a file. */
const INLINE_CODE_RUNTIMES = new Set(["node", "python", "python3", "bun", "deno"]);
/** Flags that turn the next argv element into executable code. */
const INLINE_CODE_FLAGS = new Set(["-e", "-p", "-c", "-r", "--eval", "--print", "--require", "--import", "eval"]);
const SCRIPT_FILE = /\.(m?js|cjs|ts|mts|py)$/i;

/**
 * True when an inline-code flag appears anywhere before the script file, so
 * `node --no-warnings -e ...` and bundled short flags like `python3 -Ic ...`
 * are caught, not just a flag in argv[1].
 */
function hasInlineCode(argv: readonly string[]): boolean {
  for (const raw of argv.slice(1)) {
    const part = raw.toLowerCase();
    if (SCRIPT_FILE.test(part)) return false;
    if (INLINE_CODE_FLAGS.has(part)) return true;
    if (part.startsWith("--eval=") || part.startsWith("--print=") || part.startsWith("--require=")) return true;
    if (/^-[a-z]*[ecp]$/.test(part)) return true;
  }
  return false;
}

/** True when an argument is a path that can leave the workspace root. */
function pointsOutsideWorkspace(argv: readonly string[]): boolean {
  for (const part of argv.slice(1)) {
    if (part === ".." || part.includes("../") || part.includes("..\\")) return true;
    if (/^[a-zA-Z]:[\\/]/.test(part)) return true; // drive letter
    if (/^[\\/]/.test(part)) return true;           // POSIX absolute or UNC
  }
  return false;
}

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
  const customApprove = matchesAny(argv, override?.approve ?? []) ?? matchesVerbs(argv, override?.approve ?? []);
  if (customApprove !== null) {
    return {
      verdict: "REQUIRE_APPROVAL",
      reason: `Workspace policy requires human approval for '${customApprove}'.`,
      risk: "HIGH",
    };
  }
  const builtInApprove = matchesVerbs(argv, BUILT_IN_APPROVE);
  if (builtInApprove !== null) {
    return {
      verdict: "REQUIRE_APPROVAL",
      reason: `Publishing command '${builtInApprove}' requires human approval.`,
      risk: "HIGH",
    };
  }
  if (pointsOutsideWorkspace(argv)) {
    return {
      verdict: "REQUIRE_APPROVAL",
      reason: `Argument '${argv[1] ?? ""}' points outside the workspace — human approval required.`,
      risk: "HIGH",
    };
  }
  const binary = (argv[0] ?? "").toLowerCase();
  if (INLINE_CODE_RUNTIMES.has(binary) && hasInlineCode(argv)) {
    return {
      verdict: "REQUIRE_APPROVAL",
      reason: `Interpreter '${argv[0]}' with inline code requires human approval.`,
      risk: "HIGH",
    };
  }
  if (binary === "git" && argv.slice(1).some((part) => part === "-c" || part.startsWith("--config-env") || part.startsWith("--exec-path"))) {
    return {
      verdict: "REQUIRE_APPROVAL",
      reason: "git with injected configuration (-c / --exec-path) can run arbitrary programs — human approval required.",
      risk: "HIGH",
    };
  }
  if (binary === "find" && argv.slice(1).some((part) => EXEC_CAPABLE_FLAGS.has(part.toLowerCase()))) {
    return {
      verdict: "REQUIRE_APPROVAL",
      reason: "find with -exec/-delete can run or remove arbitrary things — human approval required.",
      risk: "HIGH",
    };
  }
  if (BUILT_IN_SAFE.has(binary)) {
    return { verdict: "ALLOW", reason: "Allowed within workspace bounds.", risk: "LOW" };
  }
  return {
    verdict: "REQUIRE_APPROVAL",
    reason: `Unknown command '${argv[0]}' — human approval required.`,
    risk: "HIGH",
  };
}

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization)/i;

/**
 * Variables an agent must never set: they change which binary runs or inject
 * code into an interpreter/loader (`PATH=./bin` turns `ls` into an agent-
 * authored script; `NODE_OPTIONS=--require ./x.js` runs code in every node).
 */
const RESERVED_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "HOME", "USER", "SHELL", "IFS", "ENV", "BASH_ENV", "CDPATH",
  "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
  "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "CLASSPATH", "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "EDITOR", "VISUAL", "PAGER", "BROWSER",
]);
const RESERVED_ENV_PREFIXES = ["LD_", "DYLD_", "NODE_", "NPM_", "PYTHON", "GIT_", "PIP_", "RUSTFLAGS", "RUSTC", "CARGO_", "GOFLAGS", "GOPATH", "GOROOT", "GOPROXY", "BUN_", "DENO_", "UV_", "LC_"];
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isReservedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return RESERVED_ENV_KEYS.has(upper) || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Environment an agent child process may see: the process allow-list plus
 * agent/workspace-declared variables, minus anything shaped like a secret and
 * minus reserved loader/interpreter/PATH variables. `PATH`/`SystemRoot`
 * (Windows) and locale come only from the host process so toolchains work.
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
    if (!SAFE_ENV_KEY.test(key)) continue;
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (isReservedEnvKey(key)) continue;
    output[key] = value;
  }
  return output;
}
