import "dotenv/config";
import { createApp } from "./app.js";
import { getConfig, logger, redactedConfig } from "../../../packages/shared/src/index.js";
import { connectDatabase, disconnectDatabase, prisma } from "../../../packages/database/src/index.js";
import { verifyCommandRunner } from "../../../packages/tools/src/command-runner.js";
import { getSimulationEngine } from "../../../packages/simulation/src/index.js";
import { startExecutionWorker } from "../../../packages/execution/src/index.js";

const log = logger.child({ component: "api.main" });

async function main(): Promise<void> {
  const config = getConfig();
  log.info("Starting King World API", { action: "api.start", ...redactedConfig(config) });

  await verifyCommandRunner();
  await connectDatabase();

  // The simulation heartbeat only advances a world whose status is RUNNING; a
  // paused or stopped world costs nothing but a timer tick.
  const simulation = getSimulationEngine();
  simulation.ensureHeartbeat();
  log.info("Simulation heartbeat started", {
    action: "simulation.heartbeat_started",
    tickIntervalMs: simulation.tickIntervalMs,
  });

  // The execution worker claims queued ExecutionJobs; it is fully
  // self-scheduling, so the simulation tick is never blocked by a run.
  const executionWorker = startExecutionWorker(prisma);
  log.info("Execution worker started", { action: "execution.worker_started" });

  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`API listening on :${config.port}`, { action: "api.listening", port: config.port });
  });

  const shutdown = (signal: string): void => {
    log.info(`Received ${signal}, shutting down`, { action: "api.shutdown" });
    simulation.dispose();
    void executionWorker
      .stop()
      .catch((error: unknown) => {
        log.warn("Execution worker failed to stop cleanly", {
          action: "execution.worker_stop_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        server.close(() => {
          void disconnectDatabase().finally(() => process.exit(0));
        });
      });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log.error("Failed to start API", { action: "api.start_failed", error });
  process.exit(1);
});
