/**
 * Agent Factory (Phase 1: blueprint + approval only).
 *
 * The intended flow, deliberately NOT fully enabled in Phase 1:
 *
 *   Rashid -> AgentCreationRequest -> Human Approval -> AgentFactory
 *          -> new Agent -> role -> model -> permissions -> job -> company
 *
 * Phase 1 implements everything up to and including a human-approved blueprint,
 * and then stops. `instantiateBlueprint` exists and is fully implemented, but it
 * is reachable only from an authenticated OWNER/ADMIN via the HTTP layer, never
 * from a tool. An agent therefore *cannot* create another agent, which is the
 * whole point of routing it through approval in the first place.
 */
import {
  BlueprintStatusSchema,
  newCorrelationId,
  validationError,
  type ActorRef,
} from "../../shared/src/index.js";
import { conflict, forbidden, notFound } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Agent, AgentBlueprint } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";
import { roleProfiles } from "./role-profiles.js";
import { createAgent, type CreateAgentInput } from "./agent.service.js";

export interface BlueprintContext {
  actor: ActorRef;
  correlationId?: string;
  permissions?: ReadonlySet<Permission>;
  userId?: string;
}

export interface CreateBlueprintInput {
  name: string;
  roleKey: string;
  title: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  personality?: Record<string, unknown>;
  goals?: string[];
  skills?: string[];
  capabilities?: string[];
  companyId?: string | null;
  /** Set to move straight to PENDING_APPROVAL instead of DRAFT. */
  submitForApproval?: boolean;
}

/**
 * Records an intent to create an agent. Nothing is instantiated.
 *
 * The role is validated here rather than at instantiation time, so a bad role
 * is caught at request time instead of after a human has approved it.
 */
export async function createBlueprint(
  db: DbClient,
  input: CreateBlueprintInput,
  ctx: BlueprintContext,
): Promise<AgentBlueprint> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  roleProfiles.get(input.roleKey);

  const blueprint = await db.agentBlueprint.create({
    data: {
      name: input.name.trim().slice(0, 120),
      roleKey: input.roleKey,
      title: input.title.trim().slice(0, 160),
      systemPrompt: input.systemPrompt,
      personality: JSON.stringify(input.personality ?? {}),
      goals: JSON.stringify(input.goals ?? []),
      skills: JSON.stringify(input.skills ?? []),
      capabilities: JSON.stringify(input.capabilities ?? []),
      providerId: input.providerId,
      model: input.model,
      temperature: input.temperature ?? 0.3,
      maxTokens: input.maxTokens ?? 2048,
      companyId: input.companyId ?? null,
      requestedByAgentId: ctx.actor.actorType === "AGENT" ? (ctx.actor.actorId ?? null) : null,
      status: input.submitForApproval === true ? "PENDING_APPROVAL" : "DRAFT",
    },
  });

  if (input.submitForApproval === true) {
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.AGENT_BLUEPRINT_REQUESTED,
      actor: ctx.actor,
      correlationId,
      targetType: "AgentBlueprint",
      targetId: blueprint.id,
      companyId: input.companyId ?? undefined,
      payload: {
        blueprintId: blueprint.id,
        requestedByAgentId: blueprint.requestedByAgentId,
        name: blueprint.name,
      },
    });
  }

  await recordActivity(db, {
    actor: ctx.actor,
    action: "agent_factory.create_blueprint",
    targetType: "AgentBlueprint",
    targetId: blueprint.id,
    correlationId,
    userId: ctx.userId,
    metadata: {
      name: blueprint.name,
      roleKey: blueprint.roleKey,
      providerId: blueprint.providerId,
      model: blueprint.model,
      status: blueprint.status,
    },
  });

  return blueprint;
}

export async function listBlueprints(
  db: DbClient,
  query: { companyId?: string; status?: string } = {},
): Promise<AgentBlueprint[]> {
  return db.agentBlueprint.findMany({
    where: {
      ...(query.companyId !== undefined ? { companyId: query.companyId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getBlueprint(db: DbClient, id: string): Promise<AgentBlueprint> {
  const blueprint = await db.agentBlueprint.findUnique({ where: { id } });
  if (blueprint === null) throw notFound("AgentBlueprint", id);
  return blueprint;
}

/**
 * Human-only. Materialises an APPROVED blueprint into a real Agent.
 *
 * Refuses if the blueprint has not been approved, which is what keeps the
 * approval step load-bearing rather than decorative.
 */
export async function instantiateBlueprint(
  db: DbClient,
  blueprintId: string,
  ctx: BlueprintContext,
): Promise<Agent> {
  if (ctx.actor.actorType !== "USER" && ctx.actor.actorType !== "SYSTEM") {
    throw forbidden("Only a human may instantiate an agent");
  }
  if (ctx.permissions !== undefined && !ctx.permissions.has(PERMISSIONS.AGENT_CREATE)) {
    throw forbidden("Instantiating an agent requires 'agent.create'");
  }

  const blueprint = await getBlueprint(db, blueprintId);
  if (blueprint.status === "INSTANTIATED") {
    throw conflict("Blueprint has already been instantiated", { blueprintId });
  }
  if (blueprint.status !== "APPROVED") {
    throw conflict("Only an approved blueprint may be instantiated", {
      blueprintId,
      status: blueprint.status,
    });
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();
  roleProfiles.get(blueprint.roleKey);

  const input: CreateAgentInput = {
    name: blueprint.name,
    roleKey: blueprint.roleKey,
    title: blueprint.title,
    systemPrompt: blueprint.systemPrompt,
    providerId: blueprint.providerId,
    model: blueprint.model,
    temperature: blueprint.temperature,
    maxTokens: blueprint.maxTokens,
    personality: safeParseObject(blueprint.personality),
    goals: safeParseArray(blueprint.goals),
    skills: safeParseArray(blueprint.skills),
    capabilities: safeParseArray(blueprint.capabilities),
    currentCompanyId: blueprint.companyId,
  };

  const agent = await createAgent(db, input, {
    actor: ctx.actor,
    correlationId,
    ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
    ...(blueprint.companyId !== null ? { companyId: blueprint.companyId } : {}),
  });

  await db.agentBlueprint.update({
    where: { id: blueprintId },
    data: { status: "INSTANTIATED", instantiatedAgentId: agent.id },
  });

  return agent;
}

export async function setBlueprintStatus(
  db: DbClient,
  blueprintId: string,
  status: string,
  ctx: BlueprintContext,
): Promise<AgentBlueprint> {
  if (ctx.actor.actorType === "AGENT") {
    throw forbidden("An agent cannot change the status of an agent blueprint");
  }
  const parsed = BlueprintStatusSchema.parse(status);
  if (parsed === "INSTANTIATED") {
    throw validationError("Use instantiateBlueprint to reach the INSTANTIATED state");
  }
  await getBlueprint(db, blueprintId);
  return db.agentBlueprint.update({ where: { id: blueprintId }, data: { status: parsed } });
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeParseArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
