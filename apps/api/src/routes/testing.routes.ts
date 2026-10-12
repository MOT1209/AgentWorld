/**
 * Testing REST surface (/api/v1/testing): queue runs, inspect results,
 * list runs. Runs go through the TestingEngine and the execution queue;
 * nothing executes inline.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import { authenticate, getPrincipal } from "../middleware/authenticate.js";
import { scopeParam, scopeRefs, scoped } from "../middleware/company-scope.js";
import { requirePermission } from "../middleware/require-permission.js";
import { validate } from "../middleware/validate.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { runTestSuite, listTestRuns } from "../../../../packages/factory/src/index.js";
import { canWriteWorkspace, requireWorkspace } from "../../../../packages/workspace/src/index.js";
import { forbidden, validationError } from "../../../../packages/shared/src/index.js";

export const testingRouter: Router = Router();
testingRouter.use(authenticate);
testingRouter.use(scopeRefs);

scopeParam(testingRouter, "id", "Test run", async (id) => {
  const row = await prisma.testRun.findUnique({ where: { id }, select: { agentId: true, taskId: true, workspaceId: true } });
  return row && { agentId: row.agentId, taskId: row.taskId, workspaceId: row.workspaceId };
});

const SELF_CONTAINED_SUITES = ["BROWSER", "MOBILE", "SECURITY", "PERFORMANCE"] as const;

const RunSchema = z
  .object({
    workspaceId: z.string().max(100).optional(),
    taskId: z.string().max(100).optional(),
    name: z.string().max(120).optional(),
    suite: z.enum(["UNIT", "INTEGRATION", "E2E", "BROWSER", "MOBILE", "SECURITY", "PERFORMANCE"]).optional(),
    command: z.array(z.string().max(200)).max(20).optional(),
    url: z.string().max(500).optional(),
  })
  .refine(
    (input) =>
      input.command !== undefined ||
      input.url !== undefined ||
      (input.suite !== undefined && (SELF_CONTAINED_SUITES as readonly string[]).includes(input.suite)),
    {
      message: "Either command or url is required (BROWSER/MOBILE/SECURITY/PERFORMANCE suites may run without one)",
    },
  );

testingRouter.post(
  "/run",
  requirePermission(PERMISSIONS.TESTING_RUN),
  validate("body", RunSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as z.infer<typeof RunSchema>;
      if (body.workspaceId !== undefined) {
        // Any adapter that names a workspace can run a command inside it
        // (command/browser/mobile/security/performance all delegate to the
        // execution queue when given one), so this needs the same ACL the
        // direct /executions route enforces -- not just TESTING_RUN.
        const principal = getPrincipal(req);
        const workspace = await requireWorkspace(prisma, body.workspaceId);
        const allowed = await canWriteWorkspace(prisma, workspace, {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        });
        if (!allowed) throw forbidden("No execute access to this workspace", { workspaceId: workspace.id });
      }
      const impliedAdapter = body.command !== undefined
        ? ("command" as const)
        : body.url !== undefined
          ? ("http" as const)
          : body.suite === "BROWSER"
            ? ("browser" as const)
            : body.suite === "MOBILE"
              ? ("mobile" as const)
              : body.suite === "SECURITY"
                ? ("security" as const)
                : ("performance" as const);
      const run = await runTestSuite(prisma, {
        ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}),
        ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.suite !== undefined ? { suite: body.suite } : {}),
        adapter: impliedAdapter,
        ...(body.command !== undefined ? { argv: body.command } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
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
      const limit = q.limit !== undefined ? Number(q.limit) : undefined;
      const runs = await listTestRuns(prisma, {
        ...(q.taskId !== undefined ? { taskId: q.taskId } : {}),
        ...(q.workspaceId !== undefined ? { workspaceId: q.workspaceId } : {}),
        ...(q.suite !== undefined ? { suite: q.suite } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
      const visible = await scoped(req, runs, (r) => ({ agentId: r.agentId, taskId: r.taskId, workspaceId: r.workspaceId }));
      res.json({
        data: visible.map((run) => ({
          id: run.id,
          suite: run.suite,
          adapter: run.adapter,
          name: run.name,
          status: run.status,
          executionId: run.executionId,
          durationMs: run.durationMs,
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
