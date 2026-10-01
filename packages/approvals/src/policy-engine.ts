/**
 * Generic approval policy engine.
 *
 * Phase 1 answered exactly one question ("does this tool call need a human?")
 * with a hard-coded function. Phase 2 asks the same question from several
 * directions: tool calls, plan approval, escalation resolution, session
 * actions, and whatever comes next. Rather than grow five near-identical
 * `if`-ladders, every component registers rules against ONE engine and the
 * engine returns a single verdict.
 *
 * Contract:
 *
 *   - Rules run in registration order; the first rule that returns a verdict
 *     wins. Order therefore encodes precedence, and it is explicit.
 *   - A rule that returns null/undefined abstains.
 *   - The default verdict for an action no rule claims is DENY. Denying
 *     unknown actions is the only safe default for a system that spends money;
 *     the default rule set below opts routine actions back in, explicitly.
 *   - Verdicts are pure data. Callers decide what to do: the tool executor
 *     turns REQUIRE_APPROVAL into an ApprovalRequest, a route turns it into a
 *     403, a service refuses before it writes.
 *
 * Relationship to approval-policy.ts (the WIRED path used by ToolExecutor):
 * the default lists below DERIVE from its canonical tables so the two can
 * never drift apart. One deliberate difference remains: unknown actions
 * default to DENY here while evaluateApproval allows unknown LOW-risk
 * actions. That fail-closed default is the reason this engine exists and the
 * reason it must not silently replace the wired path until every consumer
 * (plan approval, escalation resolution, session actions) opts in explicitly.
 */
import type { RiskLevel } from "../../shared/src/index.js";
import { ALWAYS_APPROVE_ACTIONS, ROUTINE_ACTIONS } from "./approval-policy.js";

export type ApprovalVerdict = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export interface PolicySubject {
  /** Dotted action name, e.g. "plan.approve", "wallet.transfer". */
  action: string;
  /** Optional amount for spend-sensitive rules (integer minor units). */
  amountMinor?: number;
  /** The tool's own declared risk. HIGH/CRITICAL escalates (mirrors step 4 of evaluateApproval). */
  declaredRisk?: RiskLevel;
  /** Role/permission context the rule may consult. */
  actorType?: "AGENT" | "USER" | "SYSTEM";
  roleKey?: string;
  /** Free-form facts a rule may need (e.g. plan creator vs approver). */
  context?: Record<string, unknown>;
}

export interface PolicyResult {
  verdict: ApprovalVerdict;
  reason: string;
  risk: RiskLevel;
}

export type PolicyRule = (subject: PolicySubject) => PolicyResult | null | undefined;

interface NamedRule {
  name: string;
  rule: PolicyRule;
}

export class ApprovalPolicyEngine {
  private readonly rules: NamedRule[] = [];

  /**
   * Register a rule. Precedence is registration order: register the most
   * specific rules first. Returns `this` for chaining.
   */
  register(name: string, rule: PolicyRule): this {
    this.rules.push({ name, rule });
    return this;
  }

  ruleNames(): string[] {
    return this.rules.map((r) => r.name);
  }

  /** First non-abstaining rule wins; otherwise DENY (fail closed). */
  evaluate(subject: PolicySubject): PolicyResult {
    for (const { rule } of this.rules) {
      const result = rule(subject);
      if (result !== null && result !== undefined) return result;
    }
    return {
      verdict: "DENY",
      reason: `No policy rule claims action '${subject.action}'. Default is deny.`,
      risk: "HIGH",
    };
  }

  /** Convenience: true when a human must be involved. */
  requiresApproval(subject: PolicySubject): boolean {
    return this.evaluate(subject).verdict === "REQUIRE_APPROVAL";
  }
}

/**
 * The standard rule set, built from the Phase 1 policy so behaviour does not
 * change underneath existing callers:
 *
 *   1. Explicit approval-required actions  -> REQUIRE_APPROVAL
 *   2. Spend at/above threshold            -> REQUIRE_APPROVAL (below -> ALLOW,
 *      claiming the whole transfer exactly like evaluateApproval)
 *   3. HIGH/CRITICAL declared risk        -> REQUIRE_APPROVAL
 *   4. Routine actions                     -> ALLOW
 *   5. Static high-risk list               -> REQUIRE_APPROVAL
 *   6. Everything else                     -> DENY (engine default)
 *
 * `registerRule` can be called between these to tighten a specific action
 * without touching the shared defaults.
 */
export function createDefaultPolicyEngine(options?: {
  spendThresholdMinor?: number;
  alwaysApproveActions?: readonly string[];
  routineActions?: readonly string[];
  highRiskActions?: readonly string[];
}): ApprovalPolicyEngine {
  // Single source of truth: the canonical tables in approval-policy.ts.
  // ENGINE_ROUTINE_EXTRAS covers LOW-risk actions that predate the routine
  // list (each maps to an ACTION_RISK "LOW" entry); approval.decide stays
  // OUT on purpose so the human-only tool keeps its fail-closed default.
  const ENGINE_ROUTINE_EXTRAS = [
    "wallet.transfer",
    "task.detail",
    "memory.forget",
    "wallet.statement",
    "approval.list",
    "approval.get",
  ] as const;
  const always = new Set(options?.alwaysApproveActions ?? ALWAYS_APPROVE_ACTIONS);
  const routine = new Set(options?.routineActions ?? [...ROUTINE_ACTIONS, ...ENGINE_ROUTINE_EXTRAS]);
  const highRisk = new Set(
    options?.highRiskActions ?? [
      "agent.create",
      "agent.delete",
      "agent.modify",
      "company.structure.modify",
      "wallet.withdraw",
      "wallet.adjust",
      "approval.decide",
    ],
  );
  const threshold = options?.spendThresholdMinor ?? 50_000;

  return new ApprovalPolicyEngine()
    .register("always-approve-list", (subject) => {
      if (!always.has(subject.action)) return null;
      return {
        verdict: "REQUIRE_APPROVAL",
        reason: `Action '${subject.action}' is classified as requiring explicit human approval.`,
        risk: "CRITICAL",
      };
    })
    .register("spend-threshold", (subject) => {
      // Mirrors evaluateApproval's transfer branch: the amount verdict claims
      // the whole action, so a declared risk never overrides a below-threshold
      // transfer (it is ALLOW, full stop).
      if (subject.action !== "wallet.transfer" || subject.amountMinor === undefined) return null;
      if (subject.amountMinor < threshold) {
        return {
          verdict: "ALLOW",
          reason: `Transfer of ${subject.amountMinor} minor units is below the approval threshold of ${threshold}.`,
          risk: "MEDIUM",
        };
      }
      return {
        verdict: "REQUIRE_APPROVAL",
        reason:
          `Amount ${subject.amountMinor} minor units meets or exceeds the ` +
          `configured approval threshold of ${threshold}.`,
        risk: "HIGH",
      };
    })
    .register("declared-risk", (subject) => {
      // Before routine on purpose (mirrors evaluateApproval step 4): a HIGH
      // declared risk escalates even routine actions. Transfers never reach
      // here with an amount -- the spend rule above already claimed them.
      if (subject.declaredRisk !== "HIGH" && subject.declaredRisk !== "CRITICAL") return null;
      return {
        verdict: "REQUIRE_APPROVAL",
        reason: `Action '${subject.action}' declares risk '${subject.declaredRisk}'.`,
        risk: subject.declaredRisk,
      };
    })
    .register("routine-actions", (subject) => {
      if (!routine.has(subject.action)) return null;
      return {
        verdict: "ALLOW",
        reason: `Action '${subject.action}' is classified as routine.`,
        risk: "LOW",
      };
    })
    .register("high-risk-actions", (subject) => {
      if (!highRisk.has(subject.action)) return null;
      return {
        verdict: "REQUIRE_APPROVAL",
        reason: `Action '${subject.action}' is high risk.`,
        risk: "HIGH",
      };
    });
}

let sharedEngine: ApprovalPolicyEngine | null = null;

/** Process-wide engine. Components may register extra rules at boot only. */
export function policyEngine(): ApprovalPolicyEngine {
  sharedEngine ??= createDefaultPolicyEngine();
  return sharedEngine;
}

/** Test seam: replace the shared engine (and restore by passing null). */
export function setPolicyEngine(engine: ApprovalPolicyEngine | null): void {
  sharedEngine = engine;
}
