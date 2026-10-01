/**
 * Task service.
 *
 * All task mutation goes through this module, which enforces three things the
 * database cannot:
 *
 *  1. LEGAL TRANSITIONS  - per state-machine.ts.
 *  2. DEPENDENCY INTEGRITY - a task cannot start while a prerequisite is
 *     unfinished, and cycles are rejected at insert time rather than producing
 *     a permanently deadlocked graph.
 *  3. WHO MAY DO WHAT     - the creator may progress their own task, the
 *     assignee may work it, and only a caller holding `task.assign` may
 *     reassign. An agent cannot silently take over someone else's work.
 */
import {
  TaskPrioritySchema,
  TaskStatusSchema,
  TaskTypeSchema,
  invalidStateTransition,
  newCorrelationId,
  toJson,
  validationError,
  type ActorRef,
} from "../../shared/src/index.js";
import { conflict, forbidden, notFound } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Agent, Task } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";
import {
  ACTIVE_TASK_STATUSES,
  ASSIGNABLE_TASK_STATUSES,
  allowedTransitions,
  assertTransition,
  isTerminal,
} from "./state-machine.js";

export interface TaskActorContext {
  actor: ActorRef;
  /** Effective permissions. Absent means SYSTEM (unrestricted internal use). */
  permissions?: ReadonlySet<Permission>;
  agentId?: string;
  correlationId?: string;
  worldId?: string;
  companyId?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  priority?: string;
  assigneeAgentId?: string | null;
  creatorAgentId?: string | null;
  creatorUserId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  parentTaskId?: string | null;
  /** Phase 2: the plan this task decomposes, when it belongs to one. */
  planId?: string | null;
  /** Phase 2: task type, matched against agent capabilities when delegating. */
  type?: string;
  metadata?: Record<string, unknown>;
  /** Task ids that must complete before this one may start. */
  dependsOn?: string[];
}

function priorityOf(input: CreateTaskInput): string {
  const parsed = TaskPrioritySchema.safeParse(input.priority ?? "MEDIUM");
  if (!parsed.success) {
    throw validationError(`Invalid task priority: ${String(input.priority)}`);
  }
  return parsed.data;
}

function taskTypeOf(input: CreateTaskInput): string {
  const parsed = TaskTypeSchema.safeParse(input.type ?? "GENERAL");
  if (!parsed.success) {
    throw validationError(`Invalid task type: ${String(input.type)}`);
  }
  return parsed.data;
}

export async function createTask(
  db: DbClient,
  input: CreateTaskInput,
  ctx: TaskActorContext,
): Promise<Task> {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw validationError("Task title is required");
  }

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const task = await db.task.create({
    data: {
      title: input.title.trim(),
      description: input.description ?? null,
      status: input.assigneeAgentId ? "ASSIGNED" : "PENDING",
      priority: priorityOf(input),
      companyId: input.companyId ?? ctx.companyId ?? null,
      projectId: input.projectId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      planId: input.planId ?? null,
      type: taskTypeOf(input),
      creatorAgentId: input.creatorAgentId ?? ctx.agentId ?? null,
      creatorUserId: input.creatorUserId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      metadata: toJson(input.metadata ?? {}),
      ...(input.assigneeAgentId ? { plannedAt: new Date() } : {}),
    },
  });

  if (input.dependsOn !== undefined && input.dependsOn.length > 0) {
    await addDependencies(db, task.id, input.dependsOn, ctx);
  }

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.TASK_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "Task",
    targetId: task.id,
    companyId: task.companyId ?? undefined,
    worldId: ctx.worldId,
    payload: { taskId: task.id, title: task.title, createdByAgentId: task.creatorAgentId },
  });

  if (task.assigneeAgentId !== null) {
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.TASK_ASSIGNED,
      actor: ctx.actor,
      correlationId,
      targetType: "Task",
      targetId: task.id,
      companyId: task.companyId ?? undefined,
      worldId: ctx.worldId,
      payload: { taskId: task.id, assigneeAgentId: task.assigneeAgentId, assignedByAgentId: task.creatorAgentId },
    });
  }

  await recordActivity(db, {
    actor: ctx.actor,
    action: "task.create",
    targetType: "Task",
    targetId: task.id,
    correlationId,
    metadata: { title: task.title, priority: task.priority, assigneeAgentId: task.assigneeAgentId },
  });

  return task;
}

export interface UpdateTaskInput {
  status?: string;
  title?: string;
  description?: string | null;
  priority?: string;
  assigneeAgentId?: string | null;
  result?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  projectId?: string | null;
}

export async function updateTask(
  db: DbClient,
  taskId: string,
  input: UpdateTaskInput,
  ctx: TaskActorContext,
): Promise<Task> {
  const task = await requireTask(db, taskId);
  assertCanModify(task, ctx);

  const correlationId = ctx.correlationId ?? newCorrelationId();
  const nextStatus = input.status;

  if (nextStatus !== undefined) {
    const parsed = TaskStatusSchema.parse(nextStatus);
    assertTransition(task.status as never, parsed);

    if (parsed === "RUNNING" || parsed === "COMPLETED") {
      const blockers = await unmetDependencies(db, task.id);
      if (blockers.length > 0 && parsed === "RUNNING") {
        throw conflict("Task cannot start: dependencies are not satisfied", {
          taskId,
          blockingTaskIds: blockers,
        });
      }
    }

    if (parsed === "COMPLETED" && (ctx.permissions?.has(PERMISSIONS.TASK_COMPLETE) === false)) {
      throw forbidden("Caller lacks 'task.complete'");
    }
  }

  if (input.assigneeAgentId !== undefined && input.assigneeAgentId !== task.assigneeAgentId) {
    assertCanAssign(ctx);
    await assertAgentExists(db, input.assigneeAgentId);
  }

  const now = new Date();
  const updated = await db.task.update({
    where: { id: taskId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: priorityOf({ priority: input.priority } as CreateTaskInput) } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.metadata !== undefined ? { metadata: toJson(input.metadata) } : {}),
      ...(input.assigneeAgentId !== undefined
        ? { assigneeAgentId: input.assigneeAgentId, plannedAt: input.assigneeAgentId ? now : null }
        : {}),
      ...(nextStatus !== undefined
        ? {
            status: nextStatus,
            attempts: nextStatus === "RUNNING" ? { increment: 1 } : undefined,
            ...(nextStatus === "RUNNING" ? { startedAt: task.startedAt ?? now } : {}),
            ...(nextStatus === "COMPLETED" ? { completedAt: now } : {}),
            ...(nextStatus === "CANCELLED" ? { cancelledAt: now } : {}),
            ...(nextStatus === "FAILED" ? { error: input.error ?? "Task failed" } : {}),
          }
        : {}),
    },
  });

  if (nextStatus !== undefined && nextStatus !== task.status) {
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.TASK_STATUS_CHANGED,
      actor: ctx.actor,
      correlationId,
      targetType: "Task",
      targetId: taskId,
      companyId: task.companyId ?? undefined,
      worldId: ctx.worldId,
      payload: { taskId, fromStatus: task.status, toStatus: nextStatus },
    });

    await emitLifecycleEvent(db, taskId, nextStatus, updated, ctx, correlationId);
  }

  if (input.assigneeAgentId !== undefined && input.assigneeAgentId !== task.assigneeAgentId) {
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.TASK_ASSIGNED,
      actor: ctx.actor,
      correlationId,
      targetType: "Task",
      targetId: taskId,
      companyId: task.companyId ?? undefined,
      worldId: ctx.worldId,
      payload: {
        taskId,
        assigneeAgentId: input.assigneeAgentId ?? "UNASSIGNED",
        assignedByAgentId: ctx.agentId ?? null,
      },
    });
  }

  await recordActivity(db, {
    actor: ctx.actor,
    action: "task.update",
    targetType: "Task",
    targetId: taskId,
    correlationId,
    metadata: {
      fromStatus: task.status,
      toStatus: nextStatus ?? task.status,
      allowedNext: allowedTransitions(task.status as never),
      changes: Object.keys(input),
    },
  });

  return updated;
}

async function emitLifecycleEvent(
  db: DbClient,
  taskId: string,
  status: string,
  task: Task,
  ctx: TaskActorContext,
  correlationId: string,
): Promise<void> {
  const base = {
    actor: ctx.actor,
    correlationId,
    targetType: "Task",
    targetId: taskId,
    companyId: task.companyId ?? undefined,
    worldId: ctx.worldId,
  } as const;

  switch (status) {
    case "RUNNING":
      await eventBus.publishAndDispatch(db, { ...base, type: EVENT_TYPES.TASK_STARTED, payload: { taskId, assigneeAgentId: task.assigneeAgentId } });
      break;
    case "COMPLETED":
      await eventBus.publishAndDispatch(db, { ...base, type: EVENT_TYPES.TASK_COMPLETED, payload: { taskId, assigneeAgentId: task.assigneeAgentId, result: task.result } });
      break;
    case "FAILED":
      await eventBus.publishAndDispatch(db, { ...base, type: EVENT_TYPES.TASK_FAILED, payload: { taskId, error: task.error ?? "unknown" } });
      break;
    case "CANCELLED":
      await eventBus.publishAndDispatch(db, { ...base, type: EVENT_TYPES.TASK_CANCELLED, payload: { taskId, reason: task.error } });
      break;
    default:
      break;
  }
}

// =============================================================================
// DEPENDENCIES
// =============================================================================

export async function addDependencies(
  db: DbClient,
  taskId: string,
  dependsOnTaskIds: string[],
  ctx: TaskActorContext,
): Promise<void> {
  const correlationId = ctx.correlationId ?? newCorrelationId();

  for (const dependencyId of dependsOnTaskIds) {
    if (dependencyId === taskId) {
      throw validationError("A task cannot depend on itself");
    }
    if (await createsCycle(db, taskId, dependencyId)) {
      throw conflict("Dependency would create a cycle", { taskId, dependencyId });
    }
    await requireTask(db, dependencyId);
    await db.taskDependency.upsert({
      where: { taskId_dependsOnTaskId: { taskId, dependsOnTaskId: dependencyId } },
      create: { taskId, dependsOnTaskId: dependencyId },
      update: {},
    });
  }

  await recordActivity(db, {
    actor: ctx.actor,
    action: "task.add_dependency",
    targetType: "Task",
    targetId: taskId,
    correlationId,
    metadata: { dependsOnTaskIds },
  });
}

export async function removeDependency(
  db: DbClient,
  taskId: string,
  dependencyId: string,
): Promise<void> {
  await db.taskDependency.deleteMany({ where: { taskId, dependsOnTaskId: dependencyId } });
}

export async function unmetDependencies(db: DbClient, taskId: string): Promise<string[]> {
  const dependencies = await db.taskDependency.findMany({
    where: { taskId },
    include: { dependsOn: { select: { id: true, status: true } } },
  });
  return dependencies
    .map((dependency) => dependency.dependsOn)
    .filter((task) => task.status !== "COMPLETED" && task.status !== "CANCELLED")
    .map((task) => task.id);
}

export async function areDependenciesSatisfied(db: DbClient, taskId: string): Promise<boolean> {
  return (await unmetDependencies(db, taskId)).length === 0;
}

/** Walks the dependency graph upwards looking for a path back to `taskId`. */
async function createsCycle(db: DbClient, taskId: string, candidateDependencyId: string): Promise<boolean> {
  const seen = new Set<string>();
  const queue = [candidateDependencyId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);

    const parents = await db.taskDependency.findMany({
      where: { taskId: current },
      select: { dependsOnTaskId: true },
    });
    for (const parent of parents) queue.push(parent.dependsOnTaskId);
  }
  return false;
}

// =============================================================================
// QUERIES
// =============================================================================

export interface ListTasksQuery {
  status?: string | string[];
  assigneeAgentId?: string;
  creatorAgentId?: string;
  companyId?: string;
  projectId?: string;
  parentTaskId?: string;
  priority?: string;
  search?: string;
  skip?: number;
  take?: number;
}

export async function listTasks(db: DbClient, query: ListTasksQuery = {}) {
  const statuses =
    query.status === undefined
      ? undefined
      : Array.isArray(query.status)
        ? query.status
        : [query.status];

  return db.task.findMany({
    where: {
      ...(statuses !== undefined ? { status: { in: statuses } } : {}),
      ...(query.assigneeAgentId !== undefined ? { assigneeAgentId: query.assigneeAgentId } : {}),
      ...(query.creatorAgentId !== undefined ? { creatorAgentId: query.creatorAgentId } : {}),
      ...(query.companyId !== undefined ? { companyId: query.companyId } : {}),
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.parentTaskId !== undefined ? { parentTaskId: query.parentTaskId } : {}),
      ...(query.priority !== undefined ? { priority: query.priority } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { title: { contains: query.search } },
              { description: { contains: query.search } },
            ],
          }
        : {}),
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    skip: query.skip ?? 0,
    take: query.take ?? 100,
  });
}

export async function countTasks(db: DbClient, query: ListTasksQuery = {}): Promise<number> {
  const statuses =
    query.status === undefined
      ? undefined
      : Array.isArray(query.status)
        ? query.status
        : [query.status];
  return db.task.count({
    where: {
      ...(statuses !== undefined ? { status: { in: statuses } } : {}),
      ...(query.assigneeAgentId !== undefined ? { assigneeAgentId: query.assigneeAgentId } : {}),
      ...(query.companyId !== undefined ? { companyId: query.companyId } : {}),
    },
  });
}

export interface TaskDetail {
  task: Task;
  assignee: Pick<Agent, "id" | "name" | "title" | "roleKey" | "currentLocationId"> | null;
  creator: Pick<Agent, "id" | "name" | "title"> | null;
  dependencies: Array<{ id: string; title: string; status: string }>;
  dependents: Array<{ id: string; title: string; status: string }>;
  subtasks: Array<{ id: string; title: string; status: string }>;
  dependenciesSatisfied: boolean;
  allowedTransitions: readonly string[];
}

export async function getTaskDetail(db: DbClient, taskId: string): Promise<TaskDetail> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      assigneeAgent: {
        select: { id: true, name: true, title: true, roleKey: true, currentLocationId: true },
      },
      creatorAgent: { select: { id: true, name: true, title: true } },
      blockedBy: {
        include: { dependsOn: { select: { id: true, title: true, status: true } } },
      },
      blocks: {
        include: { task: { select: { id: true, title: true, status: true } } },
      },
      childTasks: { select: { id: true, title: true, status: true } },
    },
  });
  if (task === null) throw notFound("Task", taskId);

  const dependencies = task.blockedBy.map((entry) => entry.dependsOn);
  return {
    task,
    assignee: task.assigneeAgent,
    creator: task.creatorAgent,
    dependencies,
    dependents: task.blocks.map((entry) => entry.task),
    subtasks: task.childTasks,
    dependenciesSatisfied: dependencies.every(
      (dependency) => dependency.status === "COMPLETED" || dependency.status === "CANCELLED",
    ),
    allowedTransitions: allowedTransitions(task.status as never),
  };
}

/** Work an agent could pick up right now. */
export async function getNextAvailableTask(db: DbClient, agentId: string): Promise<Task | null> {
  return db.task.findFirst({
    where: {
      assigneeAgentId: agentId,
      status: { in: [...ASSIGNABLE_TASK_STATUSES] },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
}

export async function getActiveTask(db: DbClient, agentId: string): Promise<Task | null> {
  return db.task.findFirst({
    where: { assigneeAgentId: agentId, status: { in: [...ACTIVE_TASK_STATUSES] } },
    orderBy: { updatedAt: "desc" },
  });
}

export async function requireTask(db: DbClient, taskId: string): Promise<Task> {
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (task === null) throw notFound("Task", taskId);
  return task;
}

async function assertAgentExists(db: DbClient, agentId: string | null): Promise<void> {
  if (agentId === null) return;
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
  if (agent === null) throw notFound("Agent", agentId);
}

// =============================================================================
// AUTHORIZATION
// =============================================================================

function has(ctx: TaskActorContext, permission: Permission): boolean {
  if (ctx.actor.actorType === "SYSTEM") return true;
  if (ctx.permissions === undefined) return true;
  return ctx.permissions.has(permission);
}

/**
 * The creator may progress their own task, the assignee may work it, and
 * anything else requires `task.assign`. Without this, any agent holding
 * `task.update` could rewrite another agent's work.
 */
function assertCanModify(task: Task, ctx: TaskActorContext): void {
  if (ctx.actor.actorType === "SYSTEM") return;
  if (has(ctx, PERMISSIONS.TASK_ASSIGN)) return;

  const isAssignee = ctx.agentId !== undefined && task.assigneeAgentId === ctx.agentId;
  const isCreator = ctx.agentId !== undefined && task.creatorAgentId === ctx.agentId;
  const isOwningUser =
    ctx.actor.actorType === "USER" && task.creatorUserId !== null && task.creatorUserId === ctx.actor.actorId;

  if (!isAssignee && !isCreator && !isOwningUser) {
    throw forbidden("Only the assignee, the creator, or a task manager may modify this task", {
      taskId: task.id,
      agentId: ctx.agentId ?? null,
    });
  }
}

function assertCanAssign(ctx: TaskActorContext): void {
  if (ctx.actor.actorType === "SYSTEM") return;
  if (!has(ctx, PERMISSIONS.TASK_ASSIGN)) {
    throw forbidden("Caller lacks 'task.assign'");
  }
}

export function assertTaskNotTerminal(task: Task): void {
  if (isTerminal(task.status as never)) {
    throw invalidStateTransition(task.status, "PENDING", "Task");
  }
}
