/**
 * Event tools.
 *
 * `event.emit` lets an agent record its own observation into the world event log.
 *
 * Two restrictions make this safe:
 *  - Observations are recorded under AGENT_OBSERVATION, never as a system event
 *    type. An agent therefore cannot fabricate APPROVAL_GRANTED or
 *    MONEY_TRANSFERRED, which would let it forge evidence of its own authority,
 *    and an operator can always tell an agent's account apart from the record.
 *  - Only INFO/WARN severity is permitted, so an agent cannot inject CRITICAL
 *    alerts that operators treat as authoritative.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { EVENT_TYPES, eventBus } from "../../../events/src/index.js";
import { validationError } from "../../../shared/src/index.js";
import type { ToolDefinition } from "../types.js";

export const eventEmitTool: ToolDefinition<{
  category: string;
  note: string;
  severity?: "INFO" | "WARN";
}> = {
  name: "event.emit",
  description:
    "Record an observation in the world event log, for example 'I noticed the deadline slipped'. " +
    "Only OBSERVATION-level events are accepted: you cannot emit financial, approval or " +
    "permission events, which are recorded by the system itself.",
  inputSchema: z.object({
    category: z
      .string()
      .max(60)
      .regex(/^[A-Z_]+$/, "Category must be UPPER_SNAKE_CASE")
      .describe("What kind of observation this is, e.g. DELAY, RISK, BLOCKER, INSIGHT"),
    note: z.string().min(1).max(1_000).describe("What you observed"),
    severity: z.enum(["INFO", "WARN"]).default("INFO"),
  }),
  requiredPermission: PERMISSIONS.EVENT_EMIT,
  risk: "LOW",
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("event.emit requires an agent");

    const row = await eventBus.publishAndDispatch(context.db, {
      type: EVENT_TYPES.AGENT_OBSERVATION,
      actor: context.actor,
      correlationId: context.correlationId,
      targetType: "Agent",
      targetId: agentId,
      ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
      ...(context.companyId !== undefined ? { companyId: context.companyId } : {}),
      severity: input.severity ?? "INFO",
      payload: { agentId, category: input.category, note: input.note },
    });

    return {
      data: { eventId: row.id, type: row.type },
      summary: `Recorded observation ${row.id}`,
    };
  },
};

export const eventTools = [eventEmitTool];
