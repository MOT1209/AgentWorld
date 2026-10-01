import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  createTask,
  updateTask,
  listTasks,
  countTasks,
  getTaskDetail,
  getNextAvailableTask,
  addDependencies,
  removeDependency,
} from "../../../../packages/tasks/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { toTaskDto, paginated } from "../dto/index.js";

export const taskRouter: Router = Router();
taskRouter.use(authenticate);

const CreateTaskSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(5000).optional().nullable(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  assigneeAgentId: z.string().min(1).optional().nullable(),
  companyId: z.string().min(1).optional().nullable(),
  projectId: z.string().min(1).optional().nullable(),
  parentTaskId: z.string().min(1).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  dependsOn: z.array(z.string().min(1)).max(20).optional(),
});

taskRouter.post(
  "/",
  requirePermission(PERMISSIONS.TASK_CREATE),
  validate("body", CreateTaskSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateTaskSchema>;
      const task = await createTask(
        prisma,
        {
          title: body.title,
          description: body.description ?? null,
          priority: body.priority,
          assigneeAgentId: body.assigneeAgentId ?? null,
          creatorUserId: principal.userId,
          companyId: body.companyId ?? null,
          projectId: body.projectId ?? null,
          parentTaskId: body.parentTaskId ?? null,
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          ...(body.dependsOn !== undefined ? { dependsOn: body.dependsOn } : {}),
        },
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          correlationId: getCorrelationId(req),
        },
      );
      res.status(201).json({ data: toTaskDto(task as unknown as Record<string, unknown>), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

taskRouter.get(
  "/",
  requirePermission(PERMISSIONS.TASK_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const page = Math.max(1, Number(q.page ?? "1") || 1);
      const pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? "50") || 50));
      const filter = {
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.assigneeAgentId !== undefined ? { assigneeAgentId: q.assigneeAgentId } : {}),
        ...(q.companyId !== undefined ? { companyId: q.companyId } : {}),
        ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
        ...(q.priority !== undefined ? { priority: q.priority } : {}),
        ...(q.search !== undefined ? { search: q.search } : {}),
        skip: (page - 1) * pageSize,
        take: pageSize,
      };
      const [items, total] = await Promise.all([listTasks(prisma, filter), countTasks(prisma, filter)]);
      res.json({
        data: paginated(items.map((t) => toTaskDto(t as unknown as Record<string, unknown>)), total, page, pageSize),
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

taskRouter.get(
  "/next-available",
  requirePermission(PERMISSIONS.TASK_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      if (q.agentId === undefined) {
        res.status(400).json({ code: "VALIDATION_ERROR", message: "agentId query is required", correlationId: getCorrelationId(req) });
        return;
      }
      const task = await getNextAvailableTask(prisma, q.agentId);
      res.json({
        data: task === null ? null : toTaskDto(task as unknown as Record<string, unknown>),
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

taskRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.TASK_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const detail = await getTaskDetail(prisma, req.params.id as string);
      res.json({
        data: {
          ...detail,
          task: toTaskDto(detail.task as unknown as Record<string, unknown>),
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

const UpdateTaskSchema = z.object({
  status: z.enum(["PENDING", "PLANNED", "ASSIGNED", "RUNNING", "WAITING_APPROVAL", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"]).optional(),
  title: z.string().min(3).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  assigneeAgentId: z.string().min(1).nullable().optional(),
  result: z.string().max(5000).nullable().optional(),
  error: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  projectId: z.string().min(1).nullable().optional(),
});

taskRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.TASK_UPDATE),
  validate("body", UpdateTaskSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof UpdateTaskSchema>;
      const task = await updateTask(prisma, req.params.id as string, body, {
        actor: principalToActor(principal),
        permissions: principal.permissions,
        correlationId: getCorrelationId(req),
      });
      res.json({ data: toTaskDto(task as unknown as Record<string, unknown>), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const DependenciesSchema = z.object({
  dependsOn: z.array(z.string().min(1)).min(1).max(20),
});

taskRouter.post(
  "/:id/dependencies",
  requirePermission(PERMISSIONS.TASK_UPDATE),
  validate("body", DependenciesSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof DependenciesSchema>;
      await addDependencies(prisma, req.params.id as string, body.dependsOn, {
        actor: principalToActor(principal),
        permissions: principal.permissions,
        correlationId: getCorrelationId(req),
      });
      const detail = await getTaskDetail(prisma, req.params.id as string);
      res.json({ data: detail, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

taskRouter.delete(
  "/:id/dependencies/:depId",
  requirePermission(PERMISSIONS.TASK_UPDATE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await removeDependency(prisma, req.params.id as string, req.params.depId as string);
      res.json({ data: { ok: true }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
