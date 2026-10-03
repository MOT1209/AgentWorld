import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { getConfig } from "../../../packages/shared/src/index.js";
// Agent runs are started explicitly by the routes that accept a human message
// (agent chat, conversation send). There is deliberately no event-bus wakeup:
// it ran the agent a second time per message and bypassed the run rate limit.
import { correlationMiddleware } from "./middleware/correlation.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { defaultRateLimit } from "./middleware/rate-limit.js";
import { registerRoutes } from "./config/routes.js";
import { databaseHealth } from "../../../packages/database/src/index.js";

export function createApp(): Express {
  const app = express();
  const config = getConfig();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "256kb" }));
  app.use(correlationMiddleware);
  app.use(defaultRateLimit());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "kingworld-api", version: "1.0.0" });
  });

  app.get("/ready", async (_req, res) => {
    const health = await databaseHealth();
    if (!health.ok) {
      res.status(503).json({ ok: false, database: health });
      return;
    }
    res.json({ ok: true, database: health });
  });

  registerRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
