/**
 * Simulation control plane.
 *
 * Start/pause/resume/stop, speed, manual tick, and the observation snapshot the
 * dashboard polls. The heavy lifting lives in packages/simulation; this router
 * is a thin, permission-checked boundary around it.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  getSimulationEngine,
  setWorldSpeed,
  getSimulatedClock,
} from "../../../../packages/simulation/src/index.js";
import { authenticate, getPrincipal } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { validate } from "../middleware/validate.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";

export const simulationRouter: Router = Router();
simulationRouter.use(authenticate);

const WorldIdSchema = z.object({ worldId: z.string().min(1).optional() });

function optionalWorldId(req: Request): string | undefined {
  const fromQuery = typeof req.query.worldId === "string" ? req.query.worldId : undefined;
  const fromBody =
    req.body !== null && typeof req.body === "object" && typeof (req.body as { worldId?: unknown }).worldId === "string"
      ? ((req.body as { worldId: string }).worldId)
      : undefined;
  return fromQuery ?? fromBody;
}

simulationRouter.get(
  "/state",
  requirePermission(PERMISSIONS.WORLD_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const worldId = optionalWorldId(req);
      const state = await getSimulationEngine().getState(worldId);
      res.json({ data: state, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

simulationRouter.get(
  "/clock",
  requirePermission(PERMISSIONS.WORLD_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const worldId = optionalWorldId(req);
      const clock = await getSimulatedClock(prisma, worldId);
      res.json({
        data: {
          simulatedNow: clock.simulatedNow.toISOString(),
          wallNow: clock.wallNow.toISOString(),
          offsetMinutes: clock.offsetMinutes,
          timeScale: clock.timeScale,
          phase: clock.phase,
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

function controlHandler(action: "start" | "pause" | "resume" | "stop") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const engine = getSimulationEngine();
      const worldId = optionalWorldId(req);
      const world =
        action === "start"
          ? await engine.start(worldId)
          : action === "pause"
            ? await engine.pause(worldId)
            : action === "resume"
              ? await engine.resume(worldId)
              : await engine.stop(worldId);
      res.json({
        data: {
          worldId: world.id,
          status: world.status,
          timeScale: world.timeScale,
          timeOffsetMinutes: world.timeOffsetMinutes,
          heartbeatRunning: engine.isHeartbeatRunning,
          tickIntervalMs: engine.tickIntervalMs,
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  };
}

simulationRouter.post("/start", requirePermission(PERMISSIONS.WORLD_WRITE), controlHandler("start"));
simulationRouter.post("/pause", requirePermission(PERMISSIONS.WORLD_WRITE), controlHandler("pause"));
simulationRouter.post("/resume", requirePermission(PERMISSIONS.WORLD_WRITE), controlHandler("resume"));
simulationRouter.post("/stop", requirePermission(PERMISSIONS.WORLD_WRITE), controlHandler("stop"));

simulationRouter.post(
  "/tick",
  requirePermission(PERMISSIONS.WORLD_WRITE),
  validate("body", WorldIdSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const worldId = optionalWorldId(req);
      const result = await getSimulationEngine().tick(worldId === undefined ? {} : { worldId });
      res.json({ data: result, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const SetSpeedSchema = z.object({
  timeScale: z.number().positive().max(10000),
  worldId: z.string().min(1).optional(),
});

simulationRouter.post(
  "/speed",
  requirePermission(PERMISSIONS.WORLD_WRITE),
  validate("body", SetSpeedSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof SetSpeedSchema>;
      const world = await setWorldSpeed(
        prisma,
        body.timeScale,
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
        body.worldId,
      );
      res.json({
        data: { worldId: world.id, status: world.status, timeScale: world.timeScale },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);
