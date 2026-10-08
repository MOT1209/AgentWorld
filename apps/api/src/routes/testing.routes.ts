/**
 * Testing REST surface (/api/v1/testing): queue runs, inspect results,
 * list runs. Runs go through the TestingEngine and the execution queue;
 * nothing executes inline.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { validate } from "../middleware/validate.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { runTestSuite, listTestRuns } from "../../../../packages/factory/src/index.js";
import { validationError } from "../../../../packages/shared/src/index.js";

export const testingRouter: Router = Router();
testingRouter.use(authenticate);

const RunSchema = z
  .object({
    workspaceId: z.string().max(100).optional(),
    taskId: z.string().max(100).optional(),
    name: z.string().max(120).optional(),
    suite: z.enum(["UNIT", "INTEGRATION", "E2E", "BROWSER", "MOBILE", "SECURITY", "PERFORMANCE"]).optional(),
    command: z.array(z.string().max(200)).max(20).optional(),
    url: z.string().max(500).optional(),
  })
  .refine((input) => input.command !== undefined || input.url !== undefined, {
    message: "Either command or url is required",
  });

testingRouter.post(
  "/run",
  requirePermission(PERMISSIONS.TESTING_RUN),
  validate("body", RunSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as z.infer<typeof RunSchema>;
      const run = await runTestSuite(prisma, {
        ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}),
        ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.suite !== undefined ? { suite: body.suite } : {}),
        ...(body.command !== undefined ? { argv: body.command, adapter: "command" as const } : {}),
        ...(body.url !== undefined ? { url: body.url, adapter: "http" as const } : {}),
      });
      res.status(202).json({
        data: { testRunId: run.id, status: run.status, executionId: run.executionId },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

testingRouter.get(
  "/runs",
  requirePermission(PERMISSIONS.TESTING_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const runs = await listTestRuns(prisma, {
        ...(q.taskId !== undefined ? { taskId: q.taskId } : {}),
        ...(q.workspaceId !== undefined ? { workspaceId: q.workspaceId } : {}),
        ...(q.suite !== undefined ? { suite: q.suite } : {}),
      });
      res.json({
        data: runs.map((run) => ({
          id: run.id,
          suite: run.suite,
          adapter: run.adapter,
          name: run.name,
          status: run.status,
          executionId: run.executionId,
          durationMs: run.durationMs,
          createdAt: run.createdAt,
        })),
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

testingRouter.get(
  "/runs/:id",
  requirePermission(PERMISSIONS.TESTING_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const run = await prisma.testRun.findUnique({ where: { id: req.params.id as string } });
      if (run === null) throw validationError("TestRun not found");
      const safeParse = (raw: string): Record<string, unknown> => {
        try {
          const parsed = JSON.parse(raw) as unknown;
          return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      };
      res.json({
        data: {
          id: run.id,
          suite: run.suite,
          adapter: run.adapter,
          name: run.name,
          status: run.status,
          summary: safeParse(run.summary),
          evidence: safeParse(run.evidence),
          rawPath: run.rawPath,
          executionId: run.executionId,
          taskId: run.taskId,
          durationMs: run.durationMs,
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

testingRouter.use((_req: Request, res: Response): void => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown testing resource" } });
});
