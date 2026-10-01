/**
 * Delegation service.
 *
 * Answers "who should take this task?" without ever reading an agent's name.
 * The selection pipeline is deliberately boring and auditable:
 *
 *   1. CAPABLE     - the agent's declared capabilities cover the task type.
 *   2. ACTIVE      - the agent is on and under its concurrency limit.
 *   3. LEAST BUSY  - lowest load score, with a stable tie-break.
 *
 * If nobody survives steps 1-2 the caller gets a conflict error naming the
 * reason, not a silent failure and not a random assignment.
 *
 * An AGENT-initiated re-delegation is capped (`MAX_AGENT_DELEGATIONS`): a
 * task that has been handed around three times has a problem that more
 * handing-around will not fix. Humans and the system may reassign freely.
 */
import { ACTIVE_TASK_STATUSES, ASSIGNABLE_TASK_STATUSES } from "../../tasks/src/state-machine.js";
import {
  TaskTypeSchema,
  conflict,
  forbidden,
  toJsonObject,
  toJsonArray,
  validationError,
} from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Task } from "../../database/src/types.js";
import type { Permission } from "../../security/src/permissions.js";
import { PERMISSIONS } from "../../security/src/permissions.js";
import {
  agentCanHandleTaskType,
  matchingCapabilities,
  parseCapabilities,
  type Capability,
} from "../../agents/src/capabilities.js";
import type { TaskType } from "../../shared/src/index.js";
import {
  updateTask,
  requireTask,
  assertTaskNotTerminal,
  type TaskActorContext,
} from "../../tasks/src/task.service.js";
import {
  compareWorkload,
  isEligible,
  loadScore,
  type AgentWorkload,
} from "./workload.js";

/** How many times one agent may bounce a task before it must escalate. */
export const MAX_AGENT_DELEGATIONS = 3;

export interface DelegationCandidate {
  agentId: string;
  name: string;
  roleKey: string;
  capabilities: Capability[];
  matching: Capability[];
  workload: AgentWorkload;
  score: number;
}

export interface SelectAssigneeInput {
  taskType: string;
  excludeAgentIds?: string[];
  /** Restrict to agents currently at this company (optional). */
  companyId?: string;
}

async function loadWorkloads(
  db: DbClient,
  agentIds: string[],
): Promise<Map<string, AgentWorkload>> {
  const map = new Map<string, AgentWorkload>();
  if (agentIds.length === 0) return map;

  const inSet = { in: agentIds };
  const [active, queued, escalations] = await Promise.all([
    db.task.groupBy({
      by: ["assigneeAgentId"],
      where: { assigneeAgentId: inSet, status: { in: [...ACTIVE_TASK_STATUSES] } },
      _count: { _all: true },
    }),
    db.task.groupBy({
      by: ["assigneeAgentId"],
      where: { assigneeAgentId: inSet, status: { in: [...ASSIGNABLE_TASK_STATUSES] } },
      _count: { _all: true },
    }),
    db.escalation.groupBy({
      by: ["toAgentId"],
      where: { toAgentId: inSet, status: "OPEN" },
      _count: { _all: true },
    }),
  ]);

  for (const row of active) {
    const id = row.assigneeAgentId;
    if (id !== null) getOrInit(map, id).activeTasks = row._count._all;
  }
  for (const row of queued) {
    const id = row.assigneeAgentId;
    if (id !== null) getOrInit(map, id).queuedTasks = row._count._all;
  }
  for (const row of escalations) {
    const id = row.toAgentId;
    if (id !== null) getOrInit(map, id).openEscalations = row._count._all;
  }

  return map;
}

function blankWorkload(agentId: string): AgentWorkload {
  return {
    agentId,
    activeTasks: 0,
    queuedTasks: 0,
    openEscalations: 0,
    concurrency: "NORMAL",
    isActive: true,
  };
}

function getOrInit(map: Map<string, AgentWorkload>, id: string): AgentWorkload {
  const existing = map.get(id);
  if (existing !== undefined) return existing;
  const created = blankWorkload(id);
  map.set(id, created);
  return created;
}

/**
 * Full ranking of eligible agents for a task type. Exposed because the
 * planner benefits from seeing *why* someone was chosen, not just who.
 */
export async function rankCandidates(
  db: DbClient,
  input: SelectAssigneeInput,
): Promise<DelegationCandidate[]> {
  const exclude = new Set(input.excludeAgentIds ?? []);
  const parsedType = TaskTypeSchema.safeParse(input.taskType);
  if (!parsedType.success) {
    throw validationError(`Unknown task type: ${String(input.taskType)}`);
  }
  const taskType: TaskType = parsedType.data;

  const agents = await db.agent.findMany({
    where: {
      isActive: true,
      ...(input.companyId !== undefined ? { currentCompanyId: input.companyId } : {}),
    },
    select: {
      id: true,
      name: true,
      roleKey: true,
      capabilities: true,
      concurrency: true,
      isActive: true,
    },
  });

  const capable = agents.filter((agent) =>
    agentCanHandleTaskType(toJsonArray(agent.capabilities), taskType),
  );
  if (capable.length === 0) return [];

  const workloads = await loadWorkloads(
    db,
    capable.map((a) => a.id),
  );

  const candidates: DelegationCandidate[] = [];
  for (const agent of capable) {
    const capabilities = toJsonArray(agent.capabilities);
    const workload: AgentWorkload = {
      ...(workloads.get(agent.id) ?? blankWorkload(agent.id)),
      concurrency: parseConcurrency(agent.concurrency),
      isActive: agent.isActive,
    };
    if (!isEligible(workload, exclude)) continue;
    candidates.push({
      agentId: agent.id,
      name: agent.name,
      roleKey: agent.roleKey,
      capabilities: parseCapabilities(capabilities),
      matching: matchingCapabilities(capabilities, taskType),
      workload,
      score: loadScore(workload),
    });
  }

  return candidates.sort((a, b) => compareWorkload(a.workload, b.workload));
}

/** Best eligible agent for the task, or null when nobody qualifies. */
export async function selectAssignee(
  db: DbClient,
  input: SelectAssigneeInput,
): Promise<DelegationCandidate | null> {
  const ranked = await rankCandidates(db, input);
  return ranked[0] ?? null;
}

export interface DelegateTaskInput {
  /** Overrides the task's own type when selecting a candidate. */
  taskType?: string;
  excludeAgentIds?: string[];
}

export interface DelegateTaskResult {
  task: Task;
  assignee: DelegationCandidate;
  reassignedFrom: string | null;
}

/**
 * Assign a task to the best candidate. This is the only supported way for a
 * planner to hand work over -- it validates capability, capacity, and
 * reassignment limits, then goes through `updateTask` so every transition and
 * event stays intact.
 */
export async function delegateTask(
  db: DbClient,
  taskId: string,
  input: DelegateTaskInput,
  ctx: TaskActorContext,
): Promise<DelegateTaskResult> {
  const task = await requireTask(db, taskId);
  assertTaskNotTerminal(task);

  if (task.status === "RUNNING" || task.status === "WAITING_APPROVAL" || task.status === "REVIEWING") {
    throw conflict("A task already in progress cannot be delegated", {
      taskId,
      status: task.status,
    });
  }

  assertCanAssign(ctx);

  const history = delegationHistory(task);
  if (ctx.actor.actorType === "AGENT" && history.length >= MAX_AGENT_DELEGATIONS) {
    throw conflict(
      `Task has been delegated ${history.length} times already; escalate instead of reassigning`,
      { taskId, delegations: history.length, limit: MAX_AGENT_DELEGATIONS },
    );
  }

  const exclude = [...(input.excludeAgentIds ?? [])];
  if (task.assigneeAgentId !== null) exclude.push(task.assigneeAgentId);

  const assignee = await selectAssignee(db, {
    taskType: input.taskType ?? task.type,
    excludeAgentIds: exclude,
    ...(task.companyId !== null ? { companyId: task.companyId } : {}),
  });

  if (assignee === null) {
    throw conflict("No capable agent with free capacity is available for this task", {
      taskId,
      taskType: input.taskType ?? task.type,
    });
  }

  const reassignedFrom = task.assigneeAgentId;
  const updated = await updateTask(
    db,
    taskId,
    {
      assigneeAgentId: assignee.agentId,
      status: needsAssignedStatus(task.status) ? "ASSIGNED" : undefined,
      metadata: {
        ...toJsonObject(task.metadata),
        delegationHistory: [
          ...history,
          {
            toAgentId: assignee.agentId,
            byAgentId: ctx.agentId ?? null,
            at: new Date().toISOString(),
          },
        ],
      },
    },
    ctx,
  );

  return { task: updated, assignee, reassignedFrom };
}

export function delegationHistory(task: Task): Array<Record<string, unknown>> {
  const raw = toJsonObject(task.metadata).delegationHistory;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function needsAssignedStatus(status: string): boolean {
  return status === "PENDING" || status === "PLANNED" || status === "READY" || status === "BLOCKED" || status === "FAILED";
}

function parseConcurrency(value: string): AgentWorkload["concurrency"] {
  return value === "LOW" || value === "HIGH" ? value : "NORMAL";
}

function has(ctx: TaskActorContext, permission: Permission): boolean {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.permissions === undefined) return true;
  return ctx.permissions.has(permission);
}

function assertCanAssign(ctx: TaskActorContext): void {
  if (!has(ctx, PERMISSIONS.TASK_ASSIGN)) {
    throw forbidden("Caller lacks 'task.assign'");
  }
}

