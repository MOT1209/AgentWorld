/**
 * Job runner — executes ONE ExecutionJob through a backend and persists
 * the outcome. Execution is enqueued, never inline: callers only create
 * rows (tools/REST already passed permissions + command policy); this
 * function claims a row transactionally (updateMany QUEUED -> RUNNING) so
 * two callers can never run the same job, runs it, spools stdout/stderr to
 * files (paths only in the row, never bulk output), and emits
 * EXECUTION_STARTED / EXECUTION_FINISHED.
 *
 * Queue polling, scheduling, concurrency limits and retries are the
 * worker's job (M5); this module is the single claim/run/persist path the
 * worker will call.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbClient } from "../../database/src/index.js";
import { eventBus, EVENT_TYPES, type EventPayloadMap, type EventType } from "../../events/src/index.js";
import { logger, newCorrelationId, SYSTEM_ACTOR } from "../../shared/src/index.js";
import { filterEnv } from "../../tools/src/command-policy.js";
import { registerArtifact } from "../../workspace/src/index.js";
import { assertRunnable } from "./guard.js";
import { createBackend, defaultBackendId, type ExecutionBackendId, type ExecutionRequest } from "./backend.js";

const MAX_OUTPUT_BYTES = 1_048_576;
const RUNNER_TIMEOUT_MS_FALLBACK = 600_000;

/** Jobs RUNNING in THIS process, so a cancel request can abort the real child. */
const running = new Map<string, { controller: AbortController; reason: string | null }>();

/** Aborts a job running in this process. False when it is not running here. */
export function abortRunningJob(jobId: string, reason: string): boolean {
  const entry = running.get(jobId);
  if (entry === undefined) return false;
  entry.reason = reason;
  entry.controller.abort();
  return true;
}

export function isRunningHere(jobId: string): boolean {
  return running.has(jobId);
}

export interface JobRunOutcome {
  jobId: string;
  claimed: boolean;
  status?: string;
  exitCode?: number | null;
}

/**
 * `command` is a JSON argv array (COMMAND/VERIFY) or `{"prompt": "..."}`
 * (BACKEND). Anything else is a corrupt row and fails the job.
 */
export function parseCommand(command: string | null): { argv?: string[]; prompt?: string } {
  if (command === null || command.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(command);
  } catch {
    throw new Error("ExecutionJob.command is not valid JSON");
  }
  if (Array.isArray(parsed) && parsed.every((part): part is string => typeof part === "string")) {
    return { argv: parsed };
  }
  if (parsed !== null && typeof parsed === "object" && typeof (parsed as { prompt?: unknown }).prompt === "string") {
    return { prompt: (parsed as { prompt: string }).prompt };
  }
  throw new Error("ExecutionJob.command is not a JSON argv array or {prompt}");
}

function spoolOutput(
  jobId: string,
  workspacePath: string | null,
  stdout: string,
  stderr: string,
): { stdoutPath: string | null; stderrPath: string | null } {
  try {
    const dir =
      workspacePath !== null
        ? join(workspacePath, ".agentworld", "executions")
        : join(tmpdir(), "kingworld-executions");
    mkdirSync(dir, { recursive: true });
    const stdoutPath = join(dir, `${jobId}.stdout.log`);
    const stderrPath = join(dir, `${jobId}.stderr.log`);
    writeFileSync(stdoutPath, stdout, "utf8");
    writeFileSync(stderrPath, stderr, "utf8");
    return { stdoutPath, stderrPath };
  } catch {
    return { stdoutPath: null, stderrPath: null };
  }
}

function classifyError(message: string): "CONFIGURATION" | "SYSTEM" {
  const lower = message.toLowerCase();
  if (lower.includes("spawn") || lower.includes("working directory") || lower.includes("backend")) {
    return "CONFIGURATION";
  }
  return "SYSTEM";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Event emission is best-effort: a log failure never fails the job. */
async function emit<T extends EventType>(
  db: DbClient,
  type: T,
  correlationId: string,
  jobId: string,
  payload: EventPayloadMap[T],
): Promise<void> {
  try {
    await eventBus.publishAndDispatch(db, {
      type,
      actor: SYSTEM_ACTOR,
      correlationId,
      targetType: "ExecutionJob",
      targetId: jobId,
      payload,
    });
  } catch (error) {
    logger.warn("Execution event emission failed", {
      action: "execution.event_failed",
      targetType: "ExecutionJob",
      targetId: jobId,
      result: "ERROR",
      error: errorMessage(error),
      eventType: type,
      correlationId,
    });
  }
}

async function finishFailed(
  db: DbClient,
  jobId: string,
  correlationId: string,
  outcome: {
    error: string;
    errorCategory: "CONFIGURATION" | "SYSTEM" | "TRANSIENT";
    durationMs?: number;
  },
): Promise<void> {
  await db.executionJob.update({
    where: { id: jobId },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      error: outcome.error,
      errorCategory: outcome.errorCategory,
    },
  });
  await emit(db, EVENT_TYPES.EXECUTION_FAILED, correlationId, jobId, {
    executionId: jobId,
    status: "FAILED",
    error: outcome.error,
    errorCategory: outcome.errorCategory,
  });
  await emit(db, EVENT_TYPES.EXECUTION_FINISHED, correlationId, jobId, {
    executionId: jobId,
    status: "FAILED",
    exitCode: null,
    durationMs: outcome.durationMs ?? 0,
  });
}

/**
 * Settles a job whose backend never ran because a cancel won the race:
 * CANCELLED row, EXECUTION_CANCELLED + EXECUTION_FINISHED events.
 */
async function settleCancelledBeforeBackend(
  db: DbClient,
  jobId: string,
  correlationId: string,
  reason: string | null,
  startedAt: number,
): Promise<JobRunOutcome> {
  const reasonText = reason ?? "Cancelled before the backend ran";
  await db.executionJob.update({
    where: { id: jobId },
    data: { status: "CANCELLED", finishedAt: new Date(), error: reasonText, errorCategory: null },
  });
  await emit(db, EVENT_TYPES.EXECUTION_CANCELLED, correlationId, jobId, {
    executionId: jobId,
    reason: reasonText,
  });
  await emit(db, EVENT_TYPES.EXECUTION_FINISHED, correlationId, jobId, {
    executionId: jobId,
    status: "CANCELLED",
    exitCode: null,
    durationMs: Date.now() - startedAt,
  });
  return { jobId, claimed: true, status: "CANCELLED", exitCode: null };
}

/**
 * Claims and runs one queued job. Returns `{ claimed: false }` when the
 * row is missing or no longer QUEUED (already claimed/finished).
 */
export async function runJob(
  db: DbClient,
  jobId: string,
  options?: { correlationId?: string },
): Promise<JobRunOutcome> {
  const job = await db.executionJob.findUnique({ where: { id: jobId } });
  if (job === null) {
    throw new Error(`ExecutionJob '${jobId}' not found`);
  }

  const claim = await db.executionJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claim.count === 0) {
    return { jobId, claimed: false };
  }

  const correlationId = job.correlationId ?? options?.correlationId ?? newCorrelationId();
  // The abort entry is registered SYNCHRONOUSLY with the claim: from the
  // instant the row says RUNNING in this process, cancelExecution must be
  // able to reach the controller. Any await in between was a window in which
  // a cancel was answered "busy" for a job running right here.
  const entry = { controller: new AbortController(), reason: null as string | null };
  running.set(job.id, entry);
  const startedAt = Date.now();
  let backendRan = false;
  try {
    await emit(db, EVENT_TYPES.EXECUTION_CLAIMED, correlationId, job.id, {
      executionId: job.id,
      attempt: job.attempts + 1,
    });
    const backendId = (job.backendId ?? defaultBackendId()) as ExecutionBackendId;
    const workspace =
      job.workspaceId !== null ? await db.workspace.findUnique({ where: { id: job.workspaceId } }) : null;
    const cwd = job.workingDir ?? workspace?.path ?? "";
    const timeoutMs = job.timeoutMs > 0 ? job.timeoutMs : RUNNER_TIMEOUT_MS_FALLBACK;

    let request: ExecutionRequest;
    try {
      request = {
        jobId: job.id,
        kind: job.kind as ExecutionRequest["kind"],
        workspaceId: job.workspaceId,
        cwd,
        ...parseCommand(job.command),
        env: filterEnv(),
        timeoutMs,
        maxBytes: MAX_OUTPUT_BYTES,
      };
    } catch (error) {
      const message = errorMessage(error);
      await finishFailed(db, job.id, correlationId, { error: message, errorCategory: "CONFIGURATION" });
      return { jobId, claimed: true, status: "FAILED", exitCode: null };
    }

    await emit(db, EVENT_TYPES.EXECUTION_STARTED, correlationId, job.id, {
      executionId: job.id,
      backendId,
      sessionId: job.sessionId,
    });

    assertRunnable(job, request.argv, workspace);
    const backend = createBackend(backendId);
    if (cwd === "" && backendId !== "mock") {
      throw new Error("No working directory available for execution");
    }
    // A cancel that landed in the setup window means the backend never ran.
    if (entry.controller.signal.aborted) {
      return await settleCancelledBeforeBackend(db, job.id, correlationId, entry.reason, startedAt);
    }
    await emit(db, EVENT_TYPES.PROCESS_STARTED, correlationId, job.id, {
      executionId: job.id,
      backendId,
      // Binary name only: arguments may carry task text and never belong in events.
      command: request.argv?.[0] ?? (request.prompt !== undefined ? "<prompt>" : null),
    });
    backendRan = true;
    const result = await backend.run({ ...request, signal: entry.controller.signal });
    const durationMs = result.durationMs > 0 ? result.durationMs : Date.now() - startedAt;
    const cancelled = result.cancelled === true || entry.controller.signal.aborted;
    await emit(db, EVENT_TYPES.PROCESS_EXITED, correlationId, job.id, {
      executionId: job.id,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs,
    });
    const status = cancelled
      ? "CANCELLED"
      : result.timedOut
        ? "TIMEOUT"
        : result.exitCode === 0
          ? "COMPLETED"
          : "FAILED";
    const spooled = spoolOutput(job.id, workspace?.path ?? null, result.stdout, result.stderr);

    // Spooled logs become LOG artifacts so the dashboard lists them with the run.
    // Best-effort: a registration failure must never change the job's verdict.
    if (workspace !== null) {
      for (const logPath of [spooled.stdoutPath, spooled.stderrPath]) {
        if (logPath === null) continue;
        try {
          await registerArtifact(
            db,
            {
              workspaceId: workspace.id,
              path: logPath,
              kind: "LOG",
              executionId: job.id,
              sessionId: job.sessionId,
              taskId: job.taskId,
              agentId: job.agentId,
            },
            { correlationId },
          );
        } catch (error) {
          logger.warn("Artifact registration failed", {
            action: "execution.artifact_failed",
            targetType: "ExecutionJob",
            targetId: job.id,
            result: "ERROR",
            error: errorMessage(error),
          });
        }
      }
    }

    await db.executionJob.update({
      where: { id: job.id },
      data: {
        status,
        finishedAt: new Date(),
        exitCode: result.exitCode,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        result: JSON.stringify({
          exitCode: result.exitCode,
          stdoutPath: spooled.stdoutPath,
          stderrPath: spooled.stderrPath,
          durationMs,
          timedOut: result.timedOut,
        }),
        ...(status === "CANCELLED" ? { error: entry.reason ?? "Cancelled while running", errorCategory: null } : {}),
        ...(status === "TIMEOUT"
          ? { error: `Timed out after ${timeoutMs}ms`, errorCategory: "TRANSIENT" }
          : {}),
        ...(status === "FAILED" ? { error: `Exited with code ${result.exitCode ?? "?"}` } : {}),
        ...(status === "COMPLETED" ? { error: null, errorCategory: null } : {}),
      },
    });
    if (status === "CANCELLED") {
      await emit(db, EVENT_TYPES.EXECUTION_CANCELLED, correlationId, job.id, {
        executionId: job.id,
        reason: entry.reason ?? "Cancelled while running",
      });
    } else if (status === "FAILED" || status === "TIMEOUT") {
      await emit(db, EVENT_TYPES.EXECUTION_FAILED, correlationId, job.id, {
        executionId: job.id,
        status,
        error: status === "TIMEOUT" ? `Timed out after ${timeoutMs}ms` : `Exited with code ${result.exitCode ?? "?"}`,
        errorCategory: status === "TIMEOUT" ? "TRANSIENT" : null,
      });
    }
    await emit(db, EVENT_TYPES.EXECUTION_FINISHED, correlationId, job.id, {
      executionId: job.id,
      status,
      exitCode: result.exitCode,
      durationMs,
    });
    return { jobId, claimed: true, status, exitCode: result.exitCode };
  } catch (error) {
    // A cancel that arrives after the backend call has begun aborts the real
    // child; one that arrives in the setup window means "did not run", so the
    // job settles as CANCELLED, never FAILED.
    if (entry.controller.signal.aborted && !backendRan) {
      return await settleCancelledBeforeBackend(db, job.id, correlationId, entry.reason, startedAt);
    }
    const message = errorMessage(error);
    await finishFailed(db, job.id, correlationId, {
      error: message,
      errorCategory: classifyError(message),
      durationMs: Date.now() - startedAt,
    });
    return { jobId, claimed: true, status: "FAILED", exitCode: null };
  } finally {
    running.delete(job.id);
  }
}
