/**
 * Permission catalogue.
 *
 * Permissions are the ONLY authorisation primitive in the system. There is no
 * `if (agent.name === "Rashid")` anywhere, and there must never be one: a new
 * agent must be able to be granted exactly the authority it needs by
 * configuration alone.
 *
 * Two separate questions are answered here:
 *
 *   1. What a HUMAN may do      -> `UserRole` -> permission set (rbac.ts).
 *   2. What an AGENT may do     -> its RoleProfile grants (packages/agents) ?
 *                                 the permission each tool declares
 *                                 (packages/tools). Enforced in ToolExecutor.
 *
 * A tool that requires `wallet.transfer` is unusable by an agent whose role
 * does not grant it, and an agent cannot widen its own grant.
 */

export const PERMISSIONS = {
  // world
  WORLD_READ: "world.read",
  WORLD_WRITE: "world.write",

  // company
  COMPANY_READ: "company.read",
  COMPANY_WRITE: "company.write",
  COMPANY_STRUCTURE_MODIFY: "company.structure.modify",
  COMPANY_TREASURY_VIEW: "company.treasury.view",

  // agents
  AGENT_READ: "agent.read",
  AGENT_CREATE: "agent.create",
  AGENT_MODIFY: "agent.modify",
  AGENT_RUN: "agent.run",
  AGENT_DELETE: "agent.delete",

  // tasks
  TASK_READ: "task.read",
  TASK_CREATE: "task.create",
  TASK_UPDATE: "task.update",
  TASK_ASSIGN: "task.assign",
  TASK_COMPLETE: "task.complete",
  TASK_CANCEL: "task.cancel",

  // communication
  MESSAGE_READ: "message.read",
  MESSAGE_SEND: "message.send",

  // memory
  MEMORY_READ: "memory.read",
  MEMORY_WRITE: "memory.write",

  // economy
  WALLET_READ: "wallet.read",
  WALLET_TRANSFER: "wallet.transfer",
  WALLET_WITHDRAW: "wallet.withdraw",
  TRANSACTION_READ: "transaction.read",

  // approvals
  APPROVAL_READ: "approval.read",
  APPROVAL_REQUEST: "approval.request",
  APPROVAL_DECIDE: "approval.decide",

  // observability
  EVENT_READ: "event.read",
  EVENT_EMIT: "event.emit",
  AUDIT_READ: "audit.read",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/**
 * Permissions that can never be granted to an agent, only to a human.
 *
 * An agent that could approve its own spend, widen its own permissions, or
 * read the audit trail could launder any guardrail in the system. This list is
 * enforced structurally in RoleProfileRegistry, not by convention.
 */
export const HUMAN_ONLY_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.APPROVAL_DECIDE,
  PERMISSIONS.AGENT_CREATE,
  PERMISSIONS.AGENT_DELETE,
  PERMISSIONS.AGENT_MODIFY,
  PERMISSIONS.COMPANY_STRUCTURE_MODIFY,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.WALLET_WITHDRAW,
] as const;

export function assertNoHumanOnlyPermissions(permissions: readonly string[], context: string): void {
  const escalated = permissions.filter((p): p is Permission =>
    (HUMAN_ONLY_PERMISSIONS as readonly string[]).includes(p),
  );
  if (escalated.length > 0) {
    throw new Error(
      `${context} attempts to grant human-only permissions to an agent: ${escalated.join(", ")}`,
    );
  }
}

/**
 * Every permission a tool may ever declare. A tool requiring anything outside
 * this set is a bug and will fail registry construction, which stops an
 * undeclared escalation from reaching production.
 */
export function isDeclarableToolPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}
