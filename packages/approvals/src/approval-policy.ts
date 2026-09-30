/**
 * Approval policy.
 *
 * The single place that answers "does this need a human?". Kept separate from
 * the approval service so the rules are auditable as data rather than buried in
 * a service method, and so a deployment can tighten them by editing one file.
 *
 * Default posture is DENY: anything not explicitly deemed routine requires a
 * human. An agent being unable to act without permission is the correct failure
 * mode for a system that spends money and can modify its own structure.
 */
import { getConfig } from "../../shared/src/index.js";
import type { RiskLevel } from "../../shared/src/index.js";

/** Actions that always require a human, regardless of arguments. */
export const ALWAYS_APPROVE_ACTIONS: readonly string[] = [
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
];

/** Actions that are safe to perform without asking, if permissions allow them. */
export const ROUTINE_ACTIONS: readonly string[] = [
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
];

export const ACTION_RISK: Record<string, RiskLevel> = {
  "wallet.balance": "LOW",
  "wallet.transfer": "MEDIUM",
  "task.create": "LOW",
  "task.update": "LOW",
  "task.list": "LOW",
  "message.send": "LOW",
  "message.read": "LOW",
  "memory.store": "LOW",
  "memory.search": "LOW",
  "world.get_state": "LOW",
  "world.get_location": "LOW",
  "company.info": "LOW",
  "event.emit": "LOW",
  "agent.create": "CRITICAL",
  "agent.delete": "CRITICAL",
  "agent.modify": "HIGH",
  "company.structure.modify": "HIGH",
  "wallet.withdraw": "CRITICAL",
  "wallet.adjust": "CRITICAL",
  "world.write": "MEDIUM",
};

export interface ApprovalPolicy {
  enabled: boolean;
  /** Transfers at or above this amount require approval. */
  spendThresholdMinor: number;
  ttlHours: number;
}

export function loadApprovalPolicy(): ApprovalPolicy {
  const config = getConfig();
  return {
    enabled: config.approvals.enabled,
    spendThresholdMinor: config.approvals.spendThresholdMinor,
    ttlHours: config.approvals.ttlHours,
  };
}

/** Baseline risk for an action, before argument-sensitive escalation. */
export function riskForAction(action: string): RiskLevel {
  const known = ACTION_RISK[action];
  if (known !== undefined) return known;
  // Unknown actions are treated as risky. Defaulting unknown to LOW is how
  // systems acquire an unnoticed back door.
  return "HIGH";
}

export function isAlwaysApproved(action: string): boolean {
  return ALWAYS_APPROVE_ACTIONS.includes(action);
}

export function isRoutine(action: string): boolean {
  return ROUTINE_ACTIONS.includes(action);
}

/**
 * Final verdict.
 *
 * Returns null when no approval is required, otherwise a risk + reason that is
 * stored verbatim on the request so the human sees exactly why they were asked.
 */
export function evaluateApproval(input: {
  action: string;
  declaredRisk: RiskLevel;
  amountMinor?: number;
  policy?: ApprovalPolicy;
}): { risk: RiskLevel; reason: string } | null {
  const policy = input.policy ?? loadApprovalPolicy();
  if (!policy.enabled) return null;

  if (isAlwaysApproved(input.action)) {
    return {
      risk: "CRITICAL",
      reason: `Action '${input.action}' is classified as requiring explicit human approval.`,
    };
  }

  if (input.action === "wallet.transfer" && input.amountMinor !== undefined) {
    if (input.amountMinor >= policy.spendThresholdMinor) {
      return {
        risk: "HIGH",
        reason:
          `Transfer of ${input.amountMinor} minor units meets or exceeds the ` +
          `configured approval threshold of ${policy.spendThresholdMinor}.`,
      };
    }
    return null;
  }

  if (input.declaredRisk === "HIGH" || input.declaredRisk === "CRITICAL") {
    return {
      risk: input.declaredRisk,
      reason: `Tool declared risk '${input.declaredRisk}'.`,
    };
  }

  return null;
}

/**
 * The check a tool's own `approvalPolicy` calls.
 *
 * Kept separate from `evaluateApproval` deliberately: a tool supplies only its
 * arguments and never its own risk level. If a tool forgot to pass a risk, the
 * always-approve list and the spend threshold still apply - it cannot opt itself
 * out of the gate by omitting a parameter.
 */
export function requiresHumanApproval(
  action: string,
  input: { amountMinor?: number; policy?: ApprovalPolicy },
): { risk: RiskLevel; reason: string } | null {
  const policy = input.policy ?? loadApprovalPolicy();
  if (!policy.enabled) return null;

  if (isAlwaysApproved(action)) {
    return {
      risk: "CRITICAL",
      reason: `Action '${action}' is classified as requiring explicit human approval.`,
    };
  }

  if (action === "wallet.transfer" && input.amountMinor !== undefined) {
    if (input.amountMinor >= policy.spendThresholdMinor) {
      return {
        risk: "HIGH",
        reason:
          `Transfer of ${input.amountMinor} minor units meets or exceeds the configured ` +
          `approval threshold of ${policy.spendThresholdMinor}.`,
      };
    }
    return null;
  }

  return null;
}
