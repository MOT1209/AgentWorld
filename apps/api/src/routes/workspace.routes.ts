import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  archiveWorkspace,
  createWorkspace,
  defaultWorkspaceRoot,
  getWorkspace,
  listWorkspaceFiles,
  listWorkspaces,
  reapExpiredWorkspaces,
  setWorkspaceStatus,
  shareWorkspace,
  unshareWorkspace,
  workspaceEnvironment,
} from "../../../../packages/workspace/src/index.js";
import { enqueueVerification } from "../../../../packages/execution/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";

export const workspaceRouter: Router = Router();
workspaceRouter.use(authenticate);

function actorCtx(req: Request): {
  actor: ReturnType<typeof principalToActor>;
  permissions: ReturnType<typeof getPrincipal>["permissions"];
  userId: string;
  correlationId: string;
} {
  const principal = getPrincipal(req);
  return {
    actor: principalToActor(principal),
    permissions: principal.permissions,
    userId: principal.userId,
    correlationId: getCorrelationId(req),
  };
}

const CreateWorkspaceSchema = z.object({
  name: z.string().min(2).max(120),
  agentId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  type: z.enum(["PERSONAL", "PROJECT", "TEMPORARY", "SHARED"]).default("PERSONAL"),
  dir: z.string().min(1).max(120).optional(),
  environment: z.record(z.string(), z.unknown()).optional(),
  workspaceLocationId: z.string().min(1).optional(),
});

workspaceRouter.post(
  "/",
  requirePermission(PERMISSIONS.WORKSPACE_WRITE),
  validate("body", CreateWorkspaceSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = actorCtx(req);
      const body = req.body as z.infer<typeof CreateWorkspaceSchema>;
      const workspace = await createWorkspace(
        prisma,
        {
          name: body.name,
          ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
          ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
          type: body.type,
          ...(body.dir !== undefined ? { dir: body.dir } : {}),
          ...(body.environment !== undefined ? { environment: body.environment } : {}),
          ...(body.workspaceLocationId !== undefined ? { workspaceLocationId: body.workspaceLocationId } : {}),
        },
        ctx,
        { root: defaultWorkspaceRoot() },
      );
      res.status(201).json({ data: { workspace }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.get(
  "/",
  requirePermission(PERMISSIONS.WORKSPACE_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const workspaces = await listWorkspaces(prisma, {
        ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
        ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
        ...(q.type !== undefined ? { type: q.type } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: { items: workspaces }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.WORKSPACE_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = actorCtx(req);
      const workspace = await getWorkspace(prisma, req.params.id as string, ctx);
      res.json({
        data: { workspace: { ...workspace, environment: workspaceEnvironment(workspace) } },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.get(
  "/:id/files",
  requirePermission(PERMISSIONS.WORKSPACE_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = actorCtx(req);
      const rel = typeof req.query.path === "string" ? req.query.path : "";
      const files = await listWorkspaceFiles(prisma, req.params.id as string, rel, ctx);
      res.json({ data: { files }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.post(
  "/:id/verify",
  requirePermission(PERMISSIONS.WORKSPACE_EXECUTE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = actorCtx(req);
      const result = await enqueueVerification(prisma, req.params.id as string, ctx);
      res.status(202).json({
        data: { workspaceId: result.workspaceId, commands: result.commands, jobs: result.jobs },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

const StatusSchema = z.object({
  status: z.enum(["READY", "BUSY", "PAUSED", "ERROR", "ARCHIVED"]),
});

workspaceRouter.post(
  "/:id/status",
  requirePermission(PERMISSIONS.WORKSPACE_WRITE),
  validate("body", StatusSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = actorCtx(req);
      const body = req.body as z.infer<typeof StatusSchema>;
      const workspace = await setWorkspaceStatus(prisma, req.params.id as string, body.status, ctx);
      res.json({ data: { workspace }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const ShareSchema = z.object({
  agentId: z.string().min(1),
  role: z.enum(["OWNER", "MEMBER", "READER"]).default("MEMBER"),
});

workspaceRouter.post(
  "/:id/share",
  requirePermission(PERMISSIONS.WORKSPACE_WRITE),
  validate("body", ShareSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = actorCtx(req);
      const body = req.body as z.infer<typeof ShareSchema>;
      await shareWorkspace(prisma, req.params.id as string, { agentId: body.agentId, role: body.role }, ctx);
      res.json({ data: { ok: true }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const UnshareSchema = z.object({ agentId: z.string().min(1) });

workspaceRouter.post(
  "/:id/unshare",
  requirePermission(PERMISSIONS.WORKSPACE_WRITE),
  validate("body", UnshareSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = actorCtx(req);
      const body = req.body as z.infer<typeof UnshareSchema>;
      await unshareWorkspace(prisma, req.params.id as string, body.agentId, ctx);
      res.json({ data: { ok: true }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.post(
  "/:id/archive",
  requirePermission(PERMISSIONS.WORKSPACE_DELETE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = actorCtx(req);
      const workspace = await archiveWorkspace(prisma, req.params.id as string, ctx);
      res.json({ data: { workspace }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

workspaceRouter.post(
  "/reap",
  requirePermission(PERMISSIONS.WORKSPACE_ADMIN),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = actorCtx(req);
      const reaped = await reapExpiredWorkspaces(prisma, ctx);
      res.json({ data: { reaped }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
