/**
 * Tool executor: the single enforcement point.
 *
 * Every tool call in the system passes through `invoke`, in this order:
 *
 *   1. LOOKUP         - unknown tool is an error, not a silent no-op.
 *   2. AUDIENCE       - humanOnly / agentOnly gates.
 *   3. PERMISSION     - the caller's effective set must contain the tool's
 *                       declared permission. This is the authorisation check.
 *   4. VALIDATION     - Zod parse of the arguments. The model cannot bypass
 *                       schema validation by emitting the right shape.
 *   5. APPROVAL       - unless this is a replay of an approved request.
 *   6. EXECUTION      - the handler, with the caller's database handle.
 *   7. AUDIT          - a ToolInvocation row is written for every outcome,
 *                       including denials and errors.
 *
 * Steps 3 and 5 are why an agent cannot perform a privileged action: there is
 * no code path from a tool call to a handler that skips them.
 */
import {
  AppError,
  isAppError,
  logger,
  type RiskLevel,
} from "../../shared/src/index.js";
import { prisma } from "../../database/src/index.js";
import { eventBus } from "../../events/src/index.js";
import { EVENT_TYPES } from "../../events/src/index.js";
import { isAlwaysApproved, riskForAction } from "../../approvals/src/index.js";
import { requestApproval } from "../../approvals/src/index.js";
import type { Permission } from "../../security/src/permissions.js";
import type { ToolRegistry } from "./registry.js";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolSpec,
  ToolStatus,
} from "./types.js";

const log = logger.child({ component: "tools.executor" });

export interface ToolExecutorOptions {
  registry: ToolRegistry;
}

export class ToolExecutor {
  private readonly registry: ToolRegistry;

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry;
  }

  listSpecs(permissions: ReadonlySet<string>, allowedTools: string[] | "*"): ToolSpec[] {
    return this.registry.specsFor(permissions as ReadonlySet<Permission>, allowedTools);
  }

  async invoke(
    name: string,
    rawArguments: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const started = Date.now();

    // 1. Lookup
    if (!this.registry.has(name)) {
      return this.fail(
        name,
        rawArguments,
        context,
        `Unknown tool '${name}'. Available tools: ${this.registry.names().join(", ")}`,
        started,
      );
    }
    const tool = this.registry.get(name);

    // 2. Audience
    if (tool.humanOnly === true && context.agentId !== undefined) {
      return this.deny(
        name,
        rawArguments,
        context,
        tool.requiredPermission,
        `Tool '${name}' is restricted to human principals`,
        started,
      );
    }
    if (tool.agentOnly === true && context.agentId === undefined) {
      return this.deny(
        name,
        rawArguments,
        context,
        tool.requiredPermission,
        `Tool '${name}' may only be invoked by an agent`,
        started,
      );
    }

    // 3. Permission
    if (!context.permissions.has(tool.requiredPermission)) {
      return this.deny(
        name,
        rawArguments,
        context,
        tool.requiredPermission,
        `Missing permission '${tool.requiredPermission}' required by tool '${name}'`,
        started,
      );
    }

    // 4. Validation
    const parsed = tool.inputSchema.safeParse(rawArguments);
    if (!parsed.success) {
      return this.fail(
        name,
        rawArguments,
        context,
        `Invalid arguments for '${name}': ${formatIssues(parsed.error.issues)}`,
        started,
      );
    }
    const input = parsed.data as never;

    // 5. Approval
    const trigger = await this.evaluateApproval(tool, input, context);
    if (trigger !== null && context.isApprovalReplay !== true) {
      return this.hold(name, rawArguments, context, tool, input, trigger, started);
    }

    // 6. Execution
    try {
      const output = await tool.execute(context, input);
      const durationMs = Date.now() - started;

      await this.record(context, name, rawArguments, "SUCCESS", {
        ...(output.summary !== undefined ? { summary: output.summary } : {}),
        durationMs,
        ...(context.approvalRequestId !== undefined
          ? { approvalRequestId: context.approvalRequestId }
          : {}),
      });

      await eventBus.publishAndDispatch(context.db, {
        type: EVENT_TYPES.TOOL_INVOKED,
        actor: context.actor,
        correlationId: context.correlationId,
        targetType: "ToolInvocation",
        targetId: name,
        ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
        ...(context.companyId !== undefined ? { companyId: context.companyId } : {}),
        payload: {
          toolName: name,
          agentId: context.agentId ?? null,
          status: "SUCCESS",
          durationMs,
        },
      });

      return {
        status: "SUCCESS",
        toolName: name,
        data: output.data,
        ...(output.summary !== undefined ? { summary: output.summary } : {}),
        durationMs,
      };
    } catch (error) {
      const message = isAppError(error) ? error.message : String(error);
      log.warn("Tool execution failed", {
        action: "tool.execute",
        targetType: "ToolInvocation",
        targetId: name,
        result: "ERROR",
        actorType: context.actor.actorType,
        actorId: context.actor.actorId ?? undefined,
        correlationId: context.correlationId,
        error: message,
      });
      return this.fail(name, rawArguments, context, message, started, true);
    }
  }

  /**
   * Decides whether this invocation must be withheld for a human.
   *
   * Three independent reasons, any of which is sufficient:
   *   - the tool's own argument-sensitive policy escalates,
   *   - the action is on the always-approve list,
   *   - the tool declares HIGH/CRITICAL risk (or opts in via requiresApproval).
   */
  private async evaluateApproval(
    tool: { name: string; risk: RiskLevel; requiresApproval?: boolean; approvalPolicy?: (input: never, context: ToolExecutionContext) => { risk: RiskLevel; reason: string } | null | Promise<{ risk: RiskLevel; reason: string } | null> },
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<{ risk: RiskLevel; reason: string } | null> {
    const policyTrigger =
      tool.approvalPolicy !== undefined
        ? await tool.approvalPolicy(input as never, context)
        : null;
    if (policyTrigger !== null) return policyTrigger;

    if (isAlwaysApproved(tool.name)) {
      return {
        risk: "CRITICAL",
        reason: `Action '${tool.name}' is classified as requiring explicit human approval.`,
      };
    }

    const declaredRisk = riskForAction(tool.name);
    const requiresApproval =
      tool.requiresApproval ?? (declaredRisk === "HIGH" || declaredRisk === "CRITICAL");

    if (requiresApproval === true) {
      return {
        risk: tool.risk === "LOW" ? declaredRisk : tool.risk,
        reason: `Tool '${tool.name}' is classified as requiring approval (risk ${tool.risk}).`,
      };
    }

    return null;
  }

  private async hold(
    name: string,
    rawArguments: Record<string, unknown>,
    context: ToolExecutionContext,
    tool: { risk: RiskLevel },
    input: unknown,
    trigger: { risk: RiskLevel; reason: string },
    started: number,
  ): Promise<ToolExecutionResult> {
    const request = await requestApproval(
      context.db,
      {
        action: name,
        actionPayload: input,
        reason: trigger.reason,
        risk: trigger.risk,
        requester: context.actor,
        requesterAgentId: context.agentId ?? null,
        ...(context.companyId !== undefined ? { companyId: context.companyId } : {}),
        ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
        toolName: name,
        agentId: context.agentId ?? null,
      },
      {
        actor: context.actor,
        correlationId: context.correlationId,
        permissions: context.permissions,
      },
    );

    const durationMs = Date.now() - started;
    await this.record(context, name, rawArguments, "PENDING_APPROVAL", {
      durationMs,
      approvalRequestId: request.id,
      summary: `Withheld pending human approval: ${trigger.reason}`,
    });

    log.info("Tool invocation held for approval", {
      action: "tool.approval_required",
      targetType: "ApprovalRequest",
      targetId: request.id,
      actorType: context.actor.actorType,
      actorId: context.actor.actorId ?? undefined,
      correlationId: context.correlationId,
      toolName: name,
      risk: trigger.risk,
    });

    return {
      status: "PENDING_APPROVAL",
      toolName: name,
      approvalRequestId: request.id,
      error: trigger.reason,
      durationMs,
    };
  }

  private async deny(
    name: string,
    rawArguments: Record<string, unknown>,
    context: ToolExecutionContext,
    requiredPermission: Permission,
    reason: string,
    started: number,
  ): Promise<ToolExecutionResult> {
    const durationMs = Date.now() - started;
    await this.record(context, name, rawArguments, "DENIED", { durationMs, error: reason });

    await eventBus.publishAndDispatch(context.db, {
      type: EVENT_TYPES.TOOL_DENIED,
      actor: context.actor,
      correlationId: context.correlationId,
      targetType: "ToolInvocation",
      targetId: name,
      payload: {
        toolName: name,
        agentId: context.agentId ?? null,
        reason,
        requiredPermission,
      },
    });

    log.warn("Tool invocation denied", {
      action: "tool.denied",
      targetType: "ToolInvocation",
      targetId: name,
      result: "ERROR",
      actorType: context.actor.actorType,
      actorId: context.actor.actorId ?? undefined,
      correlationId: context.correlationId,
      reason,
      requiredPermission,
    });

    return { status: "DENIED", toolName: name, error: reason, durationMs };
  }

  private async fail(
    name: string,
    rawArguments: Record<string, unknown>,
    context: ToolExecutionContext,
    error: string,
    started: number,
    sideEffectsPossible = false,
  ): Promise<ToolExecutionResult> {
    const durationMs = Date.now() - started;
    await this.record(context, name, rawArguments, "ERROR", { durationMs, error });
    return {
      status: "ERROR",
      toolName: name,
      error,
      durationMs,
      ...(sideEffectsPossible ? { sideEffectsPossible: true } : {}),
    };
  }

  private async record(
    context: ToolExecutionContext,
    name: string,
    rawArguments: Record<string, unknown>,
    status: ToolStatus,
    extra: { durationMs?: number; error?: string; summary?: string; approvalRequestId?: string },
  ): Promise<void> {
    try {
      await prisma.toolInvocation.create({
        data: {
          agentId: context.agentId ?? null,
          toolName: name,
          arguments: JSON.stringify(safeArgs(rawArguments)),
          status,
          error: extra.error ?? null,
          result: extra.summary ?? null,
          durationMs: extra.durationMs ?? null,
          correlationId: context.correlationId,
          approvalRequestId: extra.approvalRequestId ?? null,
        },
      });
    } catch (auditError) {
      // A failure to write the audit row must not fail the operation, but it
      // must be loud: an unaudited privileged action is a security incident.
      log.error("Failed to record tool invocation audit row", {
        action: "tool.audit_failed",
        targetType: "ToolInvocation",
        targetId: name,
        result: "ERROR",
        correlationId: context.correlationId,
        error: auditError,
      });
    }
  }
}

export type { ToolStatus };

function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialised = JSON.stringify(args);
    if (serialised === undefined) return {};
    // Bound what an LLM can put in the audit table.
    return JSON.parse(serialised) as Record<string, unknown>;
  } catch {
    return { unserialisable: true };
  }
}

function formatIssues(issues: Array<{ path: (string | number)[]; message: string }>): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function isApprovalReplay(context: ToolExecutionContext): boolean {
  return context.isApprovalReplay === true;
}

export { AppError };
