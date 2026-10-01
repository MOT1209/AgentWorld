/**
 * Tool contracts.
 *
 * A tool is the ONLY way an agent can affect the world. There is no back door:
 * the agent runtime has no database handle of its own and cannot call a service
 * directly. Every effect therefore passes through this interface, which is what
 * makes "tools never bypass authorization" checkable rather than aspirational.
 *
 * Each tool declares, statically:
 *   - the permission it requires,
 *   - its baseline risk,
 *   - an optional policy that escalates specific arguments to an approval.
 *
 * The executor is the single enforcement point. Note that this file contains no
 * logic on purpose: it is a contract, imported by both the tools and the agent
 * runtime.
 */
import type { ZodTypeAny, ZodType } from "zod";
import type { JsonSchema } from "../../ai/src/json-schema.js";
import type { Permission } from "../../security/src/permissions.js";
import type { ActorRef, RiskLevel } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";

/** Advertised to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolExecutionContext {
  /** Present for agent-initiated calls; absent for human-driven ones. */
  agentId?: string;
  actor: ActorRef;
  correlationId: string;
  /** Effective permissions of the caller. Enforced against `requiredPermission`. */
  permissions: ReadonlySet<Permission>;
  db: DbClient;
  worldId?: string;
  companyId?: string;
  /** Set when replaying a previously approved tool call. */
  approvalRequestId?: string;
  /** Whether an approval gate is being re-run (replay must not re-request). */
  isApprovalReplay?: boolean;
  now: Date;
}

/** Escalates a specific invocation beyond the tool's baseline risk. */
export interface ApprovalTrigger {
  risk: RiskLevel;
  reason: string;
}

export interface ToolOutput {
  /** Structured result. Keep it small; it is echoed back to the model. */
  data: unknown;
  /** One-line summary rendered in the conversation timeline. */
  summary?: string;
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  requiredPermission: Permission;
  /** Baseline risk. Anything above MEDIUM is approval-gated by default. */
  risk: RiskLevel;
  /** Overrides the "risk >= HIGH means approval" default. */
  requiresApproval?: boolean;
  /**
   * Argument-sensitive escalation. Called after schema validation with the
   * parsed input, e.g. "a transfer of 50,000 needs a human, 50 does not".
   */
  approvalPolicy?: (input: TInput, context: ToolExecutionContext) => ApprovalTrigger | null;
  /** Human callers are refused. Agent-only tools (e.g. internal state writes). */
  agentOnly?: boolean;
  /** Agent callers are refused. Human-only tools (e.g. approving requests). */
  humanOnly?: boolean;
  execute(context: ToolExecutionContext, input: TInput): Promise<ToolOutput>;
}

export type AnyToolDefinition =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | ToolDefinition<never> | ToolDefinition<ZodTypeAny> | ToolDefinition<any>;

export type ToolExecutionStatus = "SUCCESS" | "DENIED" | "PENDING_APPROVAL" | "ERROR";

/** Alias used for the persisted ToolInvocation.status column. */
export type ToolStatus = ToolExecutionStatus;

export interface ToolExecutionResult {
  status: ToolExecutionStatus;
  toolName: string;
  data?: unknown;
  summary?: string;
  error?: string;
  approvalRequestId?: string;
  durationMs: number;
}
