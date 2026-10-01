export {
  ALWAYS_APPROVE_ACTIONS,
  ROUTINE_ACTIONS,
  ACTION_RISK,
  loadApprovalPolicy,
  riskForAction,
  isAlwaysApproved,
  isRoutine,
  evaluateApproval,
  requiresHumanApproval,
  type ApprovalPolicy,
} from "./approval-policy.js";

export {
  ApprovalPolicyEngine,
  createDefaultPolicyEngine,
  policyEngine,
  setPolicyEngine,
  type ApprovalVerdict,
  type PolicySubject,
  type PolicyResult,
  type PolicyRule,
} from "./policy-engine.js";

export {
  requestApproval,
  decideApproval,
  claimForExecution,
  markExecutionFailed,
  markExecutionSucceeded,
  readApprovalPayload,
  listApprovals,
  getApproval,
  countPendingApprovals,
  expireStaleApprovals,
  shouldRequireApproval,
  parseApprovalStatus,
  assertReasonPresent,
  type ApprovalContext,
  type RequestApprovalInput,
  type DecideInput,
  type ListApprovalsQuery,
  type StoredApprovalPayload,
} from "./approval.service.js";
