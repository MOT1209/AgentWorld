/**
 * Worker — an in-process poll loop started/stopped from main.ts alongside
 * the simulation heartbeat. Each tick claims up to `maxConcurrent` eligible
 * QUEUED jobs (priority desc, scheduledAt asc) and runs them through
 * runJob(); transient failures are requeued with backoff up to maxAttempts.
 * The loop is non-blocking (never awaited by the simulation tick),
 * cancellable (stop() drains in-flight jobs), and self-reschedules after
 * each tick so ticks can never overlap.
 */
import type { DbClient } from "../../database/src/index.js";
import { logger } from "../../shared/src/index.js";
import { recoverOrphanedJobs, requeueTransientFailure } from "./queue.js";
import { runJob } from "./runner.js";

const log = logger.child({ component: "execution.worker" });

export interface ExecutionWorkerOptions {
  pollIntervalMs?: number;
  maxConcurrent?: number;
}

export interface ExecutionWorkerHandle {
  /** Stops the loop and waits for in-flight jobs to finish. Idempotent. */
  stop(): Promise<void>;
  /** Number of jobs currently running through this worker. */
  running(): number;
}

export function startExecutionWorker(
  db: DbClient,
  options: ExecutionWorkerOptions = {},
): ExecutionWorkerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;
  const inFlight = new Set<Promise<void>>();
  // Ids handed to a slot but not yet claimed in the database: without this the
  // next poll would pick the same still-QUEUED row and burn a slot on a no-op.
  const dispatched = new Set<string>();
  let lastSweep = Date.now();

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        wake = null;
        timer = null;
        resolve();
      }, ms);
    });

  const runOne = async (jobId: string): Promise<void> => {
    try {
      const outcome = await runJob(db, jobId);
      if (outcome.claimed && (outcome.status === "FAILED" || outcome.status === "TIMEOUT")) {
        await requeueTransientFailure(db, jobId);
      }
    } catch (error) {
      log.warn("Execution job crashed the worker slot", {
        action: "execution.worker_job_failed",
        targetType: "ExecutionJob",
        targetId: jobId,
        result: "ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      dispatched.delete(jobId);
    }
  };

  const claimNext = async (): Promise<string | null> => {
    const next = await db.executionJob.findFirst({
      where: {
        status: "QUEUED",
        scheduledAt: { lte: new Date() },
        ...(dispatched.size > 0 ? { id: { notIn: [...dispatched] } } : {}),
      },
      orderBy: [{ priority: "desc" }, { scheduledAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    return next?.id ?? null;
  };

  const tick = async (): Promise<void> => {
    while (!stopped && inFlight.size < maxConcurrent) {
      const jobId = await claimNext();
      if (jobId === null) return;
      dispatched.add(jobId);
      const promise = runOne(jobId);
      inFlight.add(promise);
      void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    }
  };

  const sweep = async (all: boolean): Promise<void> => {
    try {
      const count = await recoverOrphanedJobs(db, { all });
      if (count > 0) {
        log.warn("Recovered orphaned execution jobs", { action: "execution.worker_recovered", count });
      }
    } catch (error) {
      log.warn("Execution recovery sweep failed", {
        action: "execution.worker_recover_failed",
        result: "ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const loop = async (): Promise<void> => {
    // At start this process owns no jobs, so any RUNNING row is an orphan of a
    // previous crash or restart.
    await sweep(true);
    while (!stopped) {
      try {
        if (Date.now() - lastSweep > 30_000) {
          lastSweep = Date.now();
          await sweep(false);
        }
        await tick();
      } catch (error) {
        log.warn("Execution worker tick failed", {
          action: "execution.worker_tick_failed",
          result: "ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (stopped) return;
      await sleep(pollIntervalMs);
    }
  };

  const loopPromise = loop();

  return {
    async stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        const resume = wake;
        wake = null;
        timer = null;
        if (resume !== null) resume();
      }
      await loopPromise;
      await Promise.allSettled([...inFlight]);
    },
    running(): number {
      return inFlight.size;
    },
  };
}
