/**
 * Task tools: create, update, list.
 *
 * `task.update` is the one tool that can change status, so it carries the
 * permission that actually matters (`task.update`) and delegates the legality
 * check to the task service, which enforces the state machine and dependency
 * integrity. The tool does not reimplement those rules.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import {
  createTask,
  getTaskDetail,
  listTasks,
  unmetDependencies,
  updateTask,
} from "../../../tasks/src/index.js";
import type { ToolDefinition } from "../types.js";

export const taskCreateTool: ToolDefinition<{
  title: string;
  description?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  assigneeAgentId?: string;
  dependsOn?: string[];
  projectId?: string;
}> = {
  name: "task.create",
  description:
    "Create a new work item. Use this to decompose an objective into concrete, individually verifiable tasks. " +
    "Give a clear title and a description that states what 'done' means. Set priority explicitly. " +
    "Optionally assign it to an agent and declare prerequisite tasks via dependsOn.",
  inputSchema: z.object({
    title: z.string().min(3).max(200).describe("Short imperative title, e.g. 'Draft launch copy'"),
    description: z
      .string()
      .max(5_000)
      .optional()
      .describe("What must be true for this task to be complete"),
    priority: z
      .enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
      .default("MEDIUM")
      .describe("LOW background, MEDIUM normal, HIGH blocks others, CRITICAL urgent"),
    assigneeAgentId: z
      .string()
      .optional()
      .describe("Agent id to assign. Omit to leave unassigned for later assignment"),
    dependsOn: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Task ids that must complete before this one can start"),
    projectId: z.string().optional().describe("Optional project to file this task under"),
  }),
  requiredPermission: PERMISSIONS.TASK_CREATE,
  risk: "LOW",
  async execute(context, input) {
    const task = await createTask(
      context.db,
      {
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        priority: input.priority,
        ...(input.assigneeAgentId !== undefined
          ? { assigneeAgentId: input.assigneeAgentId }
          : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        dependsOn: input.dependsOn ?? [],
      },
      {
        actor: context.actor,
        correlationId: context.correlationId,
        permissions: context.permissions,
        ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
        ...(context.companyId !== undefined ? { companyId: context.companyId } : {}),
        ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
      },
    );

    return {
      data: {
        taskId: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        assigneeAgentId: task.assigneeAgentId,
      },
      summary: `Created task #${task.id} "${task.title}" (${task.status})`,
    };
  },
};

export const taskUpdateTool: ToolDefinition<{
  taskId: string;
  status?: string;
  result?: string;
  error?: string;
  assigneeAgentId?: string | null;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}> = {
  name: "task.update",
  description:
    "Change a task's status, record its result or error, reassign it, or re-prioritise it. " +
    "Legal status transitions are enforced by the system; an illegal transition is rejected rather than forced. " +
    "A task cannot start while its dependencies are unmet. " +
    "When you finish work, set status to COMPLETED and put an honest description of the outcome in result.",
  inputSchema: z.object({
    taskId: z.string().describe("Id of the task to update"),
    status: z
      .enum([
        "PENDING",
        "PLANNED",
        "ASSIGNED",
        "RUNNING",
        "WAITING_APPROVAL",
        "BLOCKED",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
      ])
      .optional()
      .describe("New status. Omit to update only the other fields"),
    result: z
      .string()
      .max(5_000)
      .optional()
      .describe("What was actually achieved. Required in practice when completing a task"),
    error: z.string().max(2_000).optional().describe("Why it failed, when reporting FAILED"),
    assigneeAgentId: z
      .string()
      .nullable()
      .optional()
      .describe("Reassign. Requires the task.assign permission"),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  }),
  requiredPermission: PERMISSIONS.TASK_UPDATE,
  risk: "LOW",
  async execute(context, input) {
    const task = await updateTask(
      context.db,
      input.taskId,
      {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.assigneeAgentId !== undefined ? { assigneeAgentId: input.assigneeAgentId } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      },
      {
        actor: context.actor,
        correlationId: context.correlationId,
        permissions: context.permissions,
        ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
        ...(context.companyId !== undefined ? { companyId: context.companyId } : {}),
        ...(context.worldId !== undefined ? { worldId: context.worldId } : {}),
      },
    );

    return {
      data: {
        taskId: task.id,
        status: task.status,
        result: task.result,
        error: task.error,
      },
      summary: `Task #${task.id} is now ${task.status}`,
    };
  },
};

export const taskListTool: ToolDefinition<{
  assignedToMe?: boolean;
  status?: string;
  limit?: number;
  search?: string;
}> = {
  name: "task.list",
  description:
    "List tasks. Use assignedToMe=true to find work waiting for you, and filter by status " +
    "(for example ASSIGNED or RUNNING). Returns task ids and titles, which you need in order to update them.",
  inputSchema: z.object({
    assignedToMe: z
      .boolean()
      .default(false)
      .describe("Only tasks assigned to you"),
    status: z
      .string()
      .optional()
      .describe("Filter by a single status, e.g. ASSIGNED, RUNNING, COMPLETED"),
    limit: z.number().int().min(1).max(50).default(20),
    search: z.string().max(120).optional().describe("Substring match on title or description"),
  }),
  requiredPermission: PERMISSIONS.TASK_READ,
  risk: "LOW",
  async execute(context, input) {
    const assignedAgentId =
      input.assignedToMe === true ? context.agentId : undefined;

    const tasks = await listTasks(context.db, {
      ...(assignedAgentId !== undefined ? { assigneeAgentId: assignedAgentId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.search !== undefined ? { search: input.search } : {}),
      take: input.limit,
    });

    return {
      data: {
        tasks: await Promise.all(
          tasks.map(async (task) => {
            const blockers = await unmetDependencies(context.db, task.id);
            return {
              taskId: task.id,
              title: task.title,
              status: task.status,
              priority: task.priority,
              assigneeAgentId: task.assigneeAgentId,
              blockingTaskIds: blockers,
            };
          }),
        ),
        count: tasks.length,
      },
      summary: `Found ${tasks.length} task(s)`,
    };
  },
};

export const taskDetailTool: ToolDefinition<{ taskId: string }> = {
  name: "task.detail",
  description:
    "Read one task in full: description, status, dependencies, subtasks, recorded result and permitted next transitions.",
  inputSchema: z.object({
    taskId: z.string().describe("Id of the task to read"),
  }),
  requiredPermission: PERMISSIONS.TASK_READ,
  risk: "LOW",
  async execute(context, input) {
    const detail = await getTaskDetail(context.db, input.taskId);
    return {
      data: {
        taskId: detail.task.id,
        title: detail.task.title,
        description: detail.task.description,
        status: detail.task.status,
        priority: detail.task.priority,
        result: detail.task.result,
        error: detail.task.error,
        assigneeAgentId: detail.assignee?.id ?? null,
        dependenciesSatisfied: detail.dependenciesSatisfied,
        dependencies: detail.dependencies,
        dependents: detail.dependents,
        subtasks: detail.subtasks,
        allowedTransitions: detail.allowedTransitions,
      },
      summary: `Task #${detail.task.id}: ${detail.task.status}`,
    };
  },
};

export const taskTools = [taskCreateTool, taskUpdateTool, taskListTool, taskDetailTool];
