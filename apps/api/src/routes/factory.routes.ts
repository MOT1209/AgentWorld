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
  GithubClient,
} from "../../../../packages/factory/src/index.js";
import { validationError } from "../../../../packages/shared/src/index.js";

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
      const runs = await listFactoryRuns(prisma, q.companyId);
      res.json({
        data: runs.map((run) => ({
          id: run.id,
          repoUrl: run.repoUrl,
          stage: run.currentStage,
          createdAt: run.createdAt,
        })),
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
