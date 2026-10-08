/**
 * Software Factory REST surface (/api/v1/factory): start a run, advance one
 * stage, inspect, approve (merge is ALWAYS_APPROVE and owner-only).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import { authenticate, getPrincipal } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { validate } from "../middleware/validate.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import {
  startFactoryRun,
  advanceFactoryRun,
  listFactoryRuns,
  approveFactoryRun,
  cancelFactoryRun,
  getProjectStatus,
  suggestTeam,
  analyzeFailure,
  createFixTask,
  reviewRun,
  deployRun,
  refreshDeployments,
  rollbackDeployment,
  DEPLOY_TARGETS,
  GithubClient,
} from "../../../../packages/factory/src/index.js";
import { toJson, validationError } from "../../../../packages/shared/src/index.js";

export const factoryRouter: Router = Router();
factoryRouter.use(authenticate);

const inspect = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const StartSchema = z.object({
  repoUrl: z.string().max(300).regex(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/),
  companyId: z.string().max(100),
  instruction: z.string().max(2_000).optional(),
  maxFixAttempts: z.number().int().min(1).max(10).optional(),
});

factoryRouter.post(
  "/runs",
  requirePermission(PERMISSIONS.FACTORY_RUN),
  validate("body", StartSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof StartSchema>;
      const run = await startFactoryRun(prisma, {
        repoUrl: body.repoUrl,
        companyId: body.companyId,
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
        ...(body.instruction !== undefined ? { instruction: body.instruction } : {}),
        ...(body.maxFixAttempts !== undefined ? { maxFixAttempts: body.maxFixAttempts } : {}),
      });
      res.status(201).json({
        data: { factoryRunId: run.id, stage: run.currentStage, repoUrl: run.repoUrl },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.get(
  "/runs",
  requirePermission(PERMISSIONS.FACTORY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const limit = q.limit !== undefined ? Number(q.limit) : undefined;
      const runs = await listFactoryRuns(
        prisma,
        q.companyId,
        {
          ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
          ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        },
      );
      res.json({
        data: runs.map((run) => ({
          id: run.id,
          repoUrl: run.repoUrl,
          stage: run.currentStage,
          createdAt: run.createdAt,
        })),
        nextCursor: runs.length > 0 ? runs[runs.length - 1]?.id ?? null : null,
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.get(
  "/runs/:id",
  requirePermission(PERMISSIONS.FACTORY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const run = await prisma.factoryRun.findUnique({ where: { id: req.params.id as string } });
      if (run === null) throw validationError("FactoryRun not found");
      res.json({
        data: {
          id: run.id,
          repoUrl: run.repoUrl,
          stage: run.currentStage,
          analysis: inspect(run.analysis),
          plan: inspect(run.plan),
          github: inspect(run.github),
          stats: inspect(run.stats),
          config: inspect(run.config),
          workspaceId: run.workspaceId,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.post(
  "/runs/:id/advance",
  requirePermission(PERMISSIONS.FACTORY_RUN),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const run = await advanceFactoryRun(prisma, req.params.id as string, new GithubClient());
      res.json({
        data: { factoryRunId: run.id, stage: run.currentStage, github: inspect(run.github) },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.post(
  "/runs/:id/approve",
  requirePermission(PERMISSIONS.FACTORY_RUN),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const run = await approveFactoryRun(prisma, req.params.id as string, {
        actor: {
          actorType: "USER",
          actorId: principal.userId,
          actorName: principal.displayName,
        },
        client: new GithubClient(),
      });
      res.json({
        data: { factoryRunId: run.id, stage: run.currentStage, merged: true },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.get(
  "/runs/:id/project",
  requirePermission(PERMISSIONS.FACTORY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const project = await getProjectStatus(prisma, req.params.id as string);
      res.json({ data: project, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const TeamSchema = z.object({
  requiredSkills: z.array(z.string().max(60)).max(20).optional(),
  taskType: z.string().max(30).optional(),
  companyId: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

factoryRouter.post(
  "/runs/:id/team",
  requirePermission(PERMISSIONS.FACTORY_RUN),
  validate("body", TeamSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as z.infer<typeof TeamSchema>;
      const suggestion = await suggestTeam(prisma, {
        ...(body.requiredSkills !== undefined ? { requiredSkills: body.requiredSkills } : {}),
        ...(body.taskType !== undefined ? { taskType: body.taskType } : {}),
        ...(body.companyId !== undefined ? { companyId: body.companyId } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
      });
      // Record the suggestion so the project view shows TEAM_FORMING.
      // Assignment itself stays with the delegation engine.
      const run = await prisma.factoryRun.findUnique({ where: { id: req.params.id as string } });
      if (run === null) throw validationError("FactoryRun not found");
      await prisma.factoryRun.update({
        where: { id: run.id },
        data: { github: toJson({ ...inspect(run.github), team: { candidates: suggestion.candidates, at: new Date().toISOString() } }) },
      });
      res.json({ data: suggestion, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.get(
  "/runs/:id/failure",
  requirePermission(PERMISSIONS.FACTORY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const analysis = await analyzeFailure(prisma, req.params.id as string);
      res.json({ data: analysis, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.post(
  "/runs/:id/fix-task",
  requirePermission(PERMISSIONS.FACTORY_RUN),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const result = await createFixTask(prisma, req.params.id as string, {
        actor: principalToActor(principal),
        permissions: principal.permissions,
        correlationId: getCorrelationId(req),
      });
      res.status(201).json({ data: result, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.post(
  "/runs/:id/review",
  requirePermission(PERMISSIONS.FACTORY_RUN),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const verdict = await reviewRun(prisma, req.params.id as string, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: verdict, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const DeploySchema = z.object({
  target: z.enum(DEPLOY_TARGETS),
  environment: z.string().min(1).max(80).optional(),
  command: z.array(z.string().max(200)).max(20).optional(),
  rollbackCommand: z.array(z.string().max(200)).max(20).optional(),
  artifacts: z.array(z.string().max(300)).max(20).optional(),
});

factoryRouter.post(
  "/runs/:id/deploy",
  requirePermission(PERMISSIONS.FACTORY_RUN),
  validate("body", DeploySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof DeploySchema>;
      const deployment = await deployRun(
        prisma,
        req.params.id as string,
        {
          target: body.target,
          ...(body.environment !== undefined ? { environment: body.environment } : {}),
          ...(body.command !== undefined ? { command: body.command } : {}),
          ...(body.rollbackCommand !== undefined ? { rollbackCommand: body.rollbackCommand } : {}),
          ...(body.artifacts !== undefined ? { artifacts: body.artifacts } : {}),
        },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
      );
      res.status(201).json({ data: deployment, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.get(
  "/runs/:id/deployments",
  requirePermission(PERMISSIONS.FACTORY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const deployments = await refreshDeployments(prisma, req.params.id as string, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: deployments, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.post(
  "/runs/:id/deployments/:depId/rollback",
  requirePermission(PERMISSIONS.FACTORY_RUN),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const deployment = await rollbackDeployment(prisma, req.params.id as string, req.params.depId as string, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: deployment, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.post(
  "/runs/:id/cancel",
  requirePermission(PERMISSIONS.FACTORY_RUN),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const run = await cancelFactoryRun(prisma, req.params.id as string);
      res.json({ data: { factoryRunId: run.id, stage: run.currentStage }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

factoryRouter.use((_req: Request, res: Response): void => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown factory resource" } });
});
