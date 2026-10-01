import "dotenv/config";
import { createApp, subscribeAgentWakeup } from "./app.js";
import { getConfig, logger, redactedConfig } from "../../../packages/shared/src/index.js";
import { connectDatabase, disconnectDatabase } from "../../../packages/database/src/index.js";

const log = logger.child({ component: "api.main" });

async function main(): Promise<void> {
  const config = getConfig();
  log.info("Starting King World API", { action: "api.start", ...redactedConfig(config) });

  await connectDatabase();
  subscribeAgentWakeup();

  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`API listening on :${config.port}`, { action: "api.listening", port: config.port });
  });

  const shutdown = (signal: string): void => {
    log.info(`Received ${signal}, shutting down`, { action: "api.shutdown" });
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
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
