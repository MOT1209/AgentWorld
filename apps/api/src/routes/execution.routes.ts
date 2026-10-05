import { open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  buildVerificationReport,
  cancelQueuedExecution,
  enqueueExecution,
} from "../../../../packages/execution/src/index.js";
import { canWriteWorkspace, requireWorkspace } from "../../../../packages/workspace/src/index.js";
import { conflict, forbidden, notFound, validationError } from "../../../../packages/shared/src/index.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";

export const executionRouter: Router = Router();
executionRouter.use(authenticate);

const OUTPUT_READ_CAP = 65_536;

const CommandSchema = z.union([
  z.array(z.string().min(1)).min(1).max(128),
  z.object({ prompt: z.string().min(1).max(20_000) }),
]);

const EnqueueSchema = z.object({
  kind: z.enum(["COMMAND", "VERIFY", "BACKEND"]).default("COMMAND"),
  command: CommandSchema,
  backendId: z.enum(["local", "mock", "opencode"]).optional(),
  workspaceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  workingDir: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

executionRouter.post(
  "/",
  requirePermission(PERMISSIONS.WORKSPACE_EXECUTE),
  validate("body", EnqueueSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof EnqueueSchema>;
      const isPrompt = !Array.isArray(body.command);
      if (body.kind === "BACKEND" && !isPrompt) {
        throw validationError("BACKEND executions require a {prompt} command");
      }
      if (body.kind !== "BACKEND" && isPrompt) {
        throw validationError(`${body.kind} executions require an argv array command`);
      }
      if (body.workspaceId !== undefined) {
        const workspace = await requireWorkspace(prisma, body.workspaceId);
        const allowed = await canWriteWorkspace(prisma, workspace, {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        });
        if (!allowed) throw forbidden("No execute access to this workspace", { workspaceId: workspace.id });
      }
      // Human API callers cannot clear REQUIRE_APPROVAL commands: those go
      // through the tool/approval flow. DENY and path escapes are refused in enqueue.
      const job = await enqueueExecution(prisma, {
        kind: body.kind,
        command: JSON.stringify(body.command),
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
        ...(body.backendId !== undefined ? { backendId: body.backendId } : {}),
        ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}),
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
        ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
        ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
        ...(body.workingDir !== undefined ? { workingDir: body.workingDir } : {}),
        ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
      });
      res.status(201).json({ data: { job }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const VerifyReportSchema = z.object({
  jobIds: z.array(z.string().min(1)).min(1).max(50),
  taskId: z.string().min(1).optional(),
});

executionRouter.post(
  "/verify-report",
  requirePermission(PERMISSIONS.WORKSPACE_EXECUTE),
  validate("body", VerifyReportSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof VerifyReportSchema>;
      const report = await buildVerificationReport(
        prisma,
        body.jobIds,
        {
          actor: principalToActor(principal),
          permissions: principal.permissions,
          userId: principal.userId,
          correlationId: getCorrelationId(req),
        },
        { taskId: body.taskId ?? null },
      );
      res.status(201).json({ data: { report }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

executionRouter.get(
  "/",
  requirePermission(PERMISSIONS.WORKSPACE_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const where = {
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        ...(q.workspaceId !== undefined ? { workspaceId: q.workspaceId } : {}),
        ...(q.sessionId !== undefined ? { sessionId: q.sessionId } : {}),
      };
      const items = await prisma.executionJob.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.take !== undefined ? Math.min(200, Number(q.take) || 50) : 50,
        skip: q.skip !== undefined ? Number(q.skip) || 0 : 0,
      });
      res.json({ data: { items }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

executionRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.WORKSPACE_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const job = await prisma.executionJob.findUnique({ where: { id: req.params.id as string } });
      if (job === null) throw notFound("ExecutionJob", req.params.id as string);
      res.json({ data: { job }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

executionRouter.post(
  "/:id/cancel",
  requirePermission(PERMISSIONS.WORKSPACE_EXECUTE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const jobId = req.params.id as string;
      const result = await cancelQueuedExecution(prisma, jobId, "Cancelled via API", {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      if (result === "missing") throw notFound("ExecutionJob", jobId);
      if (result === "busy") throw conflict("Execution job is no longer queued");
      res.json({ data: { cancelled: true }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Reads spooled stdout/stderr for a finished job. The path comes from the
 * job row, which the server wrote itself; it is still re-checked against the
 * expected basename and the allowed spool directory before opening.
 */
async function readCapped(path: string): Promise<{ text: string; truncated: boolean }> {
  const info = await stat(path);
  if (info.size <= OUTPUT_READ_CAP) {
    return { text: await readFile(path, "utf8"), truncated: false };
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(OUTPUT_READ_CAP);
    const { bytesRead } = await handle.read(buffer, 0, OUTPUT_READ_CAP, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: true };
  } finally {
    await handle.close();
  }
}

function assertSpooled(path: string, jobId: string, suffix: ".stdout.log" | ".stderr.log"): void {
  const expectedName = `${jobId}${suffix}`;
  if (basename(path) !== expectedName) {
    throw validationError("Execution output path is not a spool file for this job");
  }
  const inWorkspaceSpool = path.includes(`.agentworld${sep}executions${sep}`);
  const inTmpSpool = resolve(path).startsWith(join(tmpdir(), "kingworld-executions") + sep);
  if (!inWorkspaceSpool && !inTmpSpool) {
    throw validationError("Execution output path is outside the spool directory");
  }
}

executionRouter.get(
  "/:id/output",
  requirePermission(PERMISSIONS.WORKSPACE_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const jobId = req.params.id as string;
      const job = await prisma.executionJob.findUnique({ where: { id: jobId } });
      if (job === null) throw notFound("ExecutionJob", jobId);
      if (job.result === null) throw conflict("Execution job has no output yet");

      const parsed = JSON.parse(job.result) as { stdoutPath?: string | null; stderrPath?: string | null };
      const stdoutPath = parsed.stdoutPath ?? null;
      const stderrPath = parsed.stderrPath ?? null;
      if (stdoutPath !== null) assertSpooled(stdoutPath, jobId, ".stdout.log");
      if (stderrPath !== null) assertSpooled(stderrPath, jobId, ".stderr.log");

      const stdout = stdoutPath !== null ? await readCapped(stdoutPath) : { text: "", truncated: false };
      const stderr = stderrPath !== null ? await readCapped(stderrPath) : { text: "", truncated: false };
      res.json({
        data: {
          stdout: stdout.text,
          stdoutTruncated: stdout.truncated,
          stderr: stderr.text,
          stderrTruncated: stderr.truncated,
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);
