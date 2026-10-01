import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { getConfig } from "../../../packages/shared/src/index.js";
import { correlationMiddleware } from "./middleware/correlation.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { defaultRateLimit } from "./middleware/rate-limit.js";
import { registerRoutes } from "./config/routes.js";
import { prisma, databaseHealth } from "../../../packages/database/src/index.js";
import { eventBus, EVENT_TYPES } from "../../../packages/events/src/index.js";
import { getCorrelationId } from "./middleware/correlation.js";
import { orchestrateAgentRun } from "./services/agent-orchestrator.js";
import type { Request } from "express";

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

export function subscribeAgentWakeup(): void {
  eventBus.subscribe(EVENT_TYPES.MESSAGE_SENT, (event) => {
    try {
      const payload = event.payload as { notifyAgentId?: string | null; conversationId?: string };
      const notifyAgentId = typeof payload.notifyAgentId === "string" ? payload.notifyAgentId : null;
      if (notifyAgentId === null) return;
      const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : undefined;
      const fakeReq = { correlationId: event.correlationId } as unknown as Request;
      void orchestrateAgentRun(
        {
          agentId: notifyAgentId,
          trigger: "CHAT",
          ...(conversationId !== undefined ? { conversationId } : {}),
        },
        fakeReq,
      ).catch((error: unknown) => {
        // Wakeup is best-effort; the run is recorded in the DB.
        console.error("Agent wakeup failed", error);
      });
    } catch {
      // Never let a subscriber break publishing.
    }
  });
  void prisma;
  void getCorrelationId;
}
