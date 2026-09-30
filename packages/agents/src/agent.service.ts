/**
 * Agent service: creation, configuration, and state.
 *
 * Two invariants worth calling out:
 *
 *  1. THE ROLE IS THE ONLY BEHAVIOURAL SWITCH. `roleKey` is resolved through the
 *     RoleProfileRegistry. There is no code path anywhere in this repository
 *     that branches on an agent's name, so replacing "Ahmad" with a
 *     differently-named agent of role PLANNER changes nothing about behaviour.
 *
 *  2. PROVIDER/MODEL IS DATA. `providerId` and `model` are columns. Pointing an
 *     agent at a different vendor is an UPDATE, not a deployment, and the agent
 *     loop does not change.
 */
import {
  AgentStateSchema,
  newCorrelationId,
  slugify,
  toJsonArray,
  toJsonObject,
  validationError,
  type ActorRef,
  type AgentState as AgentStateValue,
} from "../../shared/src/index.js";
import { conflict, notFound } from "../../shared/src/index.js";
import type { Prisma } from "@prisma/client";
import type { DbClient } from "../../database/src/index.js";
import type { Agent, AgentState, AgentStateHistory } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";
import { roleProfiles, type RoleProfile } from "./role-profiles.js";

export interface AgentContext {
  actor: ActorRef;
  correlationId?: string;
  permissions?: ReadonlySet<Permission>;
  userId?: string;
  worldId?: string;
  companyId?: string;
}

export interface CreateAgentInput {
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
  worldId?: string | null;
  currentLocationId?: string | null;
  currentCompanyId?: string | null;
  currentJob?: string | null;
  slug?: string;
}

export async function createAgent(
  db: DbClient,
  input: CreateAgentInput,
  ctx: AgentContext,
): Promise<Agent> {
  const correlationId = ctx.correlationId ?? newCorrelationId();

  // Fail before writing if the role does not exist: an agent with an unknown
  // role would boot without a prompt, permissions, or a tool allow-list.
  const profile = roleProfiles.get(input.roleKey);

  const slug = input.slug ?? slugify(input.name);
  if (slug.length === 0) throw validationError("Agent name must contain letters or digits");

  const existing = await db.agent.findUnique({ where: { slug } });
  if (existing !== null) {
    throw conflict("An agent with that slug already exists", { slug });
  }

  const agent = await db.agent.create({
    data: {
      name: input.name.trim().slice(0, 120),
      slug,
      roleKey: input.roleKey,
      title: input.title.trim().slice(0, 160),
      systemPrompt: input.systemPrompt,
      personality: JSON.stringify(input.personality ?? {}),
      goals: JSON.stringify(input.goals ?? []),
      skills: JSON.stringify(input.skills ?? []),
      capabilities: JSON.stringify(input.capabilities ?? []),
      providerId: input.providerId,
      model: input.model,
      temperature: input.temperature ?? profile.temperature ?? 0.3,
      maxTokens: input.maxTokens ?? 2048,
      worldId: input.worldId ?? ctx.worldId ?? null,
      currentLocationId: input.currentLocationId ?? null,
      currentCompanyId: input.currentCompanyId ?? ctx.companyId ?? null,
      currentJob: input.currentJob ?? input.title ?? null,
    },
  });

  await db.agentState.create({
    data: {
      agentId: agent.id,
      state: "OFFLINE",
      currentLocationId: agent.currentLocationId,
    },
  });

  await db.agentStateHistory.create({
    data: { agentId: agent.id, fromState: null, toState: "OFFLINE", reason: "created" },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "Agent",
    targetId: agent.id,
    worldId: agent.worldId ?? undefined,
    companyId: agent.currentCompanyId ?? undefined,
    payload: { agentId: agent.id, name: agent.name, roleKey: agent.roleKey },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "agent.create",
    targetType: "Agent",
    targetId: agent.id,
    correlationId,
    userId: ctx.userId,
    metadata: { name: agent.name, roleKey: agent.roleKey, providerId: agent.providerId, model: agent.model },
  });

  return agent;
}

export async function getAgent(db: DbClient, agentId: string): Promise<Agent> {
  const agent = await db.agent.findUnique({ where: { id: agentId } });
  if (agent === null) throw notFound("Agent", agentId);
  return agent;
}

export async function findAgentBySlug(db: DbClient, slug: string): Promise<Agent> {
  const agent = await db.agent.findUnique({ where: { slug } });
  if (agent === null) throw notFound("Agent", slug);
  return agent;
}

export async function listAgents(
  db: DbClient,
  query: { companyId?: string; roleKey?: string; isActive?: boolean; includeState?: boolean } = {},
) {
  return db.agent.findMany({
    where: {
      ...(query.companyId !== undefined ? { currentCompanyId: query.companyId } : {}),
      ...(query.roleKey !== undefined ? { roleKey: query.roleKey } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    },
    ...(query.includeState
      ? {
          include: {
            state: true,
          },
        }
      : {}),
    orderBy: { createdAt: "asc" },
  });
}

export interface UpdateAgentInput {
  name?: string;
  title?: string;
  systemPrompt?: string;
  providerId?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  goals?: string[];
  skills?: string[];
  capabilities?: string[];
  currentLocationId?: string | null;
  currentCompanyId?: string | null;
  currentJob?: string | null;
  isActive?: boolean;
}

/**
 * Configuration edits. Guarded by `agent.modify`, which is a human-only
 * permission - an agent cannot rewrite its own prompt, model or permissions.
 */
export async function updateAgent(
  db: DbClient,
  agentId: string,
  input: UpdateAgentInput,
  ctx: AgentContext,
): Promise<Agent> {
  assertCanModify(ctx);
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const agent = await getAgent(db, agentId);

  // Unchecked update input: this service writes denormalised pointer columns
  // (currentLocationId / currentCompanyId) directly rather than through nested
  // relation writes, and Prisma refuses to mix the two shapes in one payload.
  const data = {
    ...(input.name !== undefined ? { name: input.name.trim().slice(0, 120) } : {}),
    ...(input.title !== undefined ? { title: input.title.trim().slice(0, 160) } : {}),
    ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.goals !== undefined ? { goals: JSON.stringify(input.goals) } : {}),
    ...(input.skills !== undefined ? { skills: JSON.stringify(input.skills) } : {}),
    ...(input.capabilities !== undefined
      ? { capabilities: JSON.stringify(input.capabilities) }
      : {}),
    ...(input.currentLocationId !== undefined ? { currentLocationId: input.currentLocationId } : {}),
    ...(input.currentCompanyId !== undefined ? { currentCompanyId: input.currentCompanyId } : {}),
    ...(input.currentJob !== undefined ? { currentJob: input.currentJob } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  } satisfies Prisma.AgentUncheckedUpdateInput;

  const updated = await db.agent.update({ where: { id: agentId }, data });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "agent.update",
    targetType: "Agent",
    targetId: agentId,
    correlationId,
    userId: ctx.userId,
    metadata: {
      changed: Object.keys(input),
      previousProvider: { providerId: agent.providerId, model: agent.model },
    },
  });

  return updated;
}

export async function changeAgentProvider(
  db: DbClient,
  agentId: string,
  input: { providerId: string; model: string; temperature?: number },
  ctx: AgentContext,
): Promise<Agent> {
  return updateAgent(
    db,
    agentId,
    {
      providerId: input.providerId,
      model: input.model,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    },
    ctx,
  );
}

// =============================================================================
// STATE
// =============================================================================

export interface ChangeStateInput {
  agentId: string;
  state: string;
  activity?: string | null;
  reason?: string;
  currentTaskId?: string | null;
}

export async function changeAgentState(
  db: DbClient,
  input: ChangeStateInput,
  ctx: AgentContext,
): Promise<AgentState> {
  const state = AgentStateSchema.parse(input.state);
  const correlationId = ctx.correlationId ?? newCorrelationId();

  const current = await db.agentState.findUnique({ where: { agentId: input.agentId } });
  if (current === null) throw notFound("AgentState for agent", input.agentId);

  if (current.state === state && input.activity === undefined) return current;

  const updated = await db.agentState.update({
    where: { agentId: input.agentId },
    data: {
      state,
      ...(input.activity !== undefined ? { activity: input.activity } : {}),
      ...(input.currentTaskId !== undefined ? { currentTaskId: input.currentTaskId } : {}),
      lastActivityAt: new Date(),
      ...(state === "ERROR" ? { errorCount: { increment: 1 } } : {}),
    },
  });

  await db.agentStateHistory.create({
    data: {
      agentId: input.agentId,
      fromState: current.state,
      toState: state,
      activity: input.activity ?? null,
      reason: input.reason ?? null,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_STATE_CHANGED,
    actor: ctx.actor,
    correlationId,
    targetType: "AgentState",
    targetId: updated.id,
    worldId: ctx.worldId,
    payload: {
      agentId: input.agentId,
      fromState: current.state,
      toState: state,
      activity: input.activity ?? null,
    },
  });

  return updated;
}

export async function getAgentState(db: DbClient, agentId: string): Promise<AgentState> {
  const state = await db.agentState.findUnique({ where: { agentId } });
  if (state === null) throw notFound("AgentState for agent", agentId);
  return state;
}

export async function getStateHistory(
  db: DbClient,
  agentId: string,
  limit = 50,
): Promise<AgentStateHistory[]> {
  return db.agentStateHistory.findMany({
    where: { agentId },
    orderBy: { changedAt: "desc" },
    take: limit,
  });
}

// =============================================================================
// EFFECTIVE CONFIGURATION
// =============================================================================

export interface AgentRuntimeProfile {
  agent: Agent;
  role: RoleProfile;
  goals: string[];
  skills: string[];
  capabilities: string[];
  personality: Record<string, unknown>;
  /** Permissions after intersecting the role grant with capability claims. */
  effectivePermissions: Permission[];
}

/**
 * Assembles everything the runtime needs for one turn.
 *
 * The permission set is the intersection of what the ROLE grants and what the
 * agent DECLARES it can do. Narrowing by declaration means an agent can be
 * provisioned with fewer rights than its role allows without changing the role
 * or writing new code.
 */
export async function buildRuntimeProfile(
  db: DbClient,
  agentId: string,
): Promise<AgentRuntimeProfile> {
  const agent = await getAgent(db, agentId);
  const role = roleProfiles.get(agent.roleKey);

  const declared = toJsonArray(agent.capabilities).filter(
    (value): value is Permission => value in PERMISSIONS,
  );
  const declaredSet = new Set<Permission>(declared);

  const effectivePermissions =
    declared.length > 0
      ? role.permissions.filter((permission) => declaredSet.has(permission))
      : [...role.permissions];

  return {
    agent,
    role,
    goals: toJsonArray(agent.goals),
    skills: toJsonArray(agent.skills),
    capabilities: declared,
    personality: toJsonObject(agent.personality),
    effectivePermissions,
  };
}

/** Tools this agent may invoke: role allow-list AND effective permissions. */
export function toolsAllowedFor(profile: AgentRuntimeProfile): "*" | string[] {
  if (profile.role.allowedTools === "*") return "*";
  return profile.role.allowedTools;
}

export async function listAgentsInCompany(db: DbClient, companyId: string): Promise<Agent[]> {
  return db.agent.findMany({ where: { currentCompanyId: companyId }, orderBy: { createdAt: "asc" } });
}

export async function countAgentsByState(
  db: DbClient,
): Promise<Record<string, number>> {
  const grouped = await db.agentState.groupBy({ by: ["state"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const group of grouped) counts[group.state] = group._count._all;
  return counts;
}

function assertCanModify(ctx: AgentContext): void {
  if (ctx.actor.actorType === "SYSTEM") return;
  if (ctx.permissions === undefined) return;
  if (!ctx.permissions.has(PERMISSIONS.AGENT_MODIFY)) {
    throw conflict("Modifying an agent requires 'agent.modify', which agents do not hold");
  }
}

export type { AgentStateValue };
