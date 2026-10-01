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
 */
import type { RiskLevel } from "../../shared/src/index.js";

export type ApprovalVerdict = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export interface PolicySubject {
  /** Dotted action name, e.g. "plan.approve", "wallet.transfer". */
  action: string;
  /** Optional amount for spend-sensitive rules (integer minor units). */
  amountMinor?: number;
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
 *   2. Spend at/above threshold            -> REQUIRE_APPROVAL
 *   3. Routine actions                     -> ALLOW
 *   4. HIGH/CRITICAL declared risk         -> REQUIRE_APPROVAL
 *   5. Everything else                     -> DENY (engine default)
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
  const always = new Set(
    options?.alwaysApproveActions ?? [
      "agent.create",
      "agent.delete",
      "agent.modify",
      "agent.set_permissions",
      "company.structure.modify",
      "wallet.withdraw",
      "wallet.adjust",
      "world.write",
      "external.action",
      "admin.impersonate",
    ],
  );
  const routine = new Set(
    options?.routineActions ?? [
      "task.create",
      "task.update",
      "task.list",
      "message.send",
      "message.read",
      "memory.store",
      "memory.search",
      "world.get_state",
      "world.get_location",
      "company.info",
      "wallet.balance",
      "event.emit",
      "plan.create",
      "plan.update",
      "plan.list",
      "plan.get",
      "report.submit",
      "review.submit",
      "agent.escalate",
      "session.start",
      "session.status",
    ],
  );
  const highRisk = new Set(
    options?.highRiskActions ?? [
      "agent.create",
      "agent.delete",
      "agent.modify",
      "company.structure.modify",
      "wallet.withdraw",
      "wallet.adjust",
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
      if (subject.amountMinor === undefined) return null;
      if (subject.amountMinor < threshold) return null;
      return {
        verdict: "REQUIRE_APPROVAL",
        reason:
          `Amount ${subject.amountMinor} minor units meets or exceeds the ` +
          `configured approval threshold of ${threshold}.`,
        risk: "HIGH",
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
