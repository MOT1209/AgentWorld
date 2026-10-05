/**
 * Queue — the only server-side way to create or requeue ExecutionJob rows.
 * HTTP handlers and tools call enqueueExecution(); the worker (worker.ts)
 * claims and runs them. Nothing ever executes inline.
 */
import type { DbClient } from "../../database/src/index.js";
import type { ExecutionJob } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { conflict, newCorrelationId, SYSTEM_ACTOR, validationError, type ActorRef } from "../../shared/src/index.js";
import { assertExecutionAllowed } from "./guard.js";
import { abortRunningJob, isRunningHere, parseCommand } from "./runner.js";

const RETRY_BACKOFF_BASE_MS = 250;

export interface EnqueueExecutionInput {
  kind: "COMMAND" | "VERIFY" | "BACKEND";
  /** JSON argv array or `{"prompt": "..."}` — validated before it hits a row. */
  command: string;
  actor?: ActorRef;
  correlationId?: string;
  backendId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  workingDir?: string | null;
  timeoutMs?: number;
  priority?: number;
  maxAttempts?: number;
  scheduledAt?: Date;
  /** Set only by callers that already passed the approval flow (tool executor). */
  policyCleared?: boolean;
  /**
   * Retried creates with the same key return the original job instead of a
   * duplicate. Callers namespace it themselves (e.g. `${taskId}:${step}`).
   */
  idempotencyKey?: string;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** A key may only replay the same request shape; anything else is a caller bug. */
function replayOf(existing: ExecutionJob, input: EnqueueExecutionInput): ExecutionJob {
  if (
    existing.workspaceId !== (input.workspaceId ?? null) ||
    existing.command !== input.command ||
    existing.kind !== input.kind
  ) {
    throw conflict("Idempotency key was already used for a different execution");
  }
  return existing;
}

export async function enqueueExecution(
  db: DbClient,
  input: EnqueueExecutionInput,
): Promise<ExecutionJob> {
  if (input.idempotencyKey !== undefined) {
    const existing = await db.executionJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing !== null) return replayOf(existing, input);
  }
  const parsed = parseCommand(input.command);
  if ((input.kind === "BACKEND") !== (parsed.prompt !== undefined)) {
    throw validationError(
      input.kind === "BACKEND"
        ? "BACKEND executions require a {prompt} command"
        : `${input.kind} executions require an argv array command`,
    );
  }
  const guarded = await assertExecutionAllowed(
    db,
    {
      kind: input.kind,
      argv: parsed.argv,
      backendId: input.backendId ?? null,
      workspaceId: input.workspaceId ?? null,
      workingDir: input.workingDir ?? null,
    },
    { policyCleared: input.policyCleared === true },
  );
  const correlationId = input.correlationId ?? newCorrelationId();
  let job: ExecutionJob;
  try {
    job = await db.executionJob.create({
    data: {
      idempotencyKey: input.idempotencyKey ?? null,
      kind: input.kind,
      command: input.command,
      backendId: input.backendId ?? null,
      workspaceId: input.workspaceId ?? null,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      workingDir: guarded.cwd,
      timeoutMs: input.timeoutMs ?? 600_000,
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 1,
      scheduledAt: input.scheduledAt ?? new Date(),
      correlationId,
    },
    });
  } catch (error) {
    // Two concurrent creates with one key: the loser returns the winner's row.
    if (input.idempotencyKey !== undefined && isUniqueViolation(error)) {
      const winner = await db.executionJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (winner !== null) return replayOf(winner, input);
    }
    throw error;
  }
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.EXECUTION_QUEUED,
    actor: input.actor ?? SYSTEM_ACTOR,
    correlationId,
    targetType: "ExecutionJob",
    targetId: job.id,
    payload: { executionId: job.id, workspaceId: job.workspaceId, backendId: job.backendId },
  });
  return job;
}

/**
 * Requeues a terminal failure whose error category is retryable (TRANSIENT),
 * respecting maxAttempts. Returns true when the row went back to QUEUED.
 */
export async function requeueTransientFailure(db: DbClient, jobId: string): Promise<boolean> {
  const job = await db.executionJob.findUnique({ where: { id: jobId } });
  if (job === null) return false;
  if (job.status !== "FAILED" && job.status !== "TIMEOUT") return false;
  if (job.errorCategory !== "TRANSIENT") return false;
  if (job.attempts >= job.maxAttempts) return false;

  await db.executionJob.update({
    where: { id: jobId },
    data: {
      status: "QUEUED",
      finishedAt: null,
      scheduledAt: new Date(Date.now() + RETRY_BACKOFF_BASE_MS * job.attempts),
    },
  });
  return true;
}

/**
 * Cancels a job that is still QUEUED (a RUNNING job is cancelled through
 * ProcessManager, not here). Returns false when the row is missing or the
 * status is no longer QUEUED.
 */
export async function cancelQueuedExecution(
  db: DbClient,
  jobId: string,
  reason: string,
  options?: { actor?: ActorRef; correlationId?: string },
): Promise<"missing" | "busy" | "cancelled"> {
  const job = await db.executionJob.findUnique({ where: { id: jobId } });
  if (job === null) return "missing";
  if (job.status !== "QUEUED") return "busy";

  const claim = await db.executionJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { status: "CANCELLED", finishedAt: new Date(), error: reason, errorCategory: null },
  });
  if (claim.count === 0) return "busy";

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.EXECUTION_CANCELLED,
    actor: options?.actor ?? SYSTEM_ACTOR,
    correlationId: options?.correlationId ?? job.correlationId ?? newCorrelationId(),
    targetType: "ExecutionJob",
    targetId: jobId,
    payload: { executionId: jobId, reason },
  });
  return "cancelled";
}

/**
 * Cancels a job wherever it is: QUEUED rows flip straight to CANCELLED, a job
 * RUNNING in this process has its child tree killed (the runner then records
 * CANCELLED). A RUNNING row with no live owner is an orphan: recovery, not a
 * cancel, settles it.
 */
export async function cancelExecution(
  db: DbClient,
  jobId: string,
  reason: string,
  options?: { actor?: ActorRef; correlationId?: string },
): Promise<"missing" | "busy" | "cancelled" | "cancelling"> {
  const queued = await cancelQueuedExecution(db, jobId, reason, options);
  if (queued !== "busy") return queued;
  const job = await db.executionJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (job?.status === "RUNNING" && abortRunningJob(jobId, reason)) return "cancelling";
  return "busy";
}

export interface RecoverOptions {
  /** Treat every RUNNING row as orphaned (true at process start: this process owns none yet). */
  all?: boolean;
  /** Extra time beyond a job's own timeout before a RUNNING row counts as stuck. */
  graceMs?: number;
}

/**
 * Settles RUNNING jobs nobody is running. A job with attempts left goes back
 * to QUEUED (the process died, the work did not run to a verdict); otherwise
 * it fails with a SYSTEM error so it never sits in RUNNING silently.
 */
export async function recoverOrphanedJobs(db: DbClient, options: RecoverOptions = {}): Promise<number> {
  const graceMs = options.graceMs ?? 60_000;
  const candidates = await db.executionJob.findMany({ where: { status: "RUNNING" } });
  let recovered = 0;
  for (const job of candidates) {
    if (isRunningHere(job.id)) continue;
    const startedMs = job.startedAt?.getTime() ?? 0;
    const stale = Date.now() > startedMs + job.timeoutMs + graceMs;
    if (options.all !== true && !stale) continue;

    const requeue = job.attempts < job.maxAttempts;
    const reason = options.all === true ? "Worker restarted while the job was running" : "Job exceeded its timeout without a result";
    const claim = await db.executionJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: requeue
        ? { status: "QUEUED", startedAt: null, scheduledAt: new Date(), error: reason, errorCategory: "TRANSIENT" }
        : { status: "FAILED", finishedAt: new Date(), error: reason, errorCategory: "SYSTEM" },
    });
    if (claim.count === 0) continue;
    recovered += 1;
    await eventBus.publishAndDispatch(db, {
      type: EVENT_TYPES.EXECUTION_RECOVERED,
      actor: SYSTEM_ACTOR,
      correlationId: job.correlationId ?? newCorrelationId(),
      targetType: "ExecutionJob",
      targetId: job.id,
      payload: { executionId: job.id, outcome: requeue ? "REQUEUED" : "FAILED", reason },
    });
  }
  return recovered;
}
