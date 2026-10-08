import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  getWorldSnapshot,
  tickWorld,
  listCities,
  listDistricts,
  listLocations,
  getLocationDetail,
  moveAgent,
  createWorld,
  createCity,
  createDistrict,
  createLocation,
  getSimulatedTime,
  listWorlds,
} from "../../../../packages/world/src/index.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getPrincipal } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";

export const worldRouter: Router = Router();
worldRouter.use(authenticate);

worldRouter.get(
  "/snapshot",
  requirePermission(PERMISSIONS.WORLD_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const worldId = typeof req.query.worldId === "string" ? req.query.worldId : undefined;
      const snapshot = await getWorldSnapshot(prisma, worldId);
      res.json({ data: snapshot, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

worldRouter.get(
  "/time",
  requirePermission(PERMISSIONS.WORLD_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const worldId = typeof req.query.worldId === "string" ? req.query.worldId : undefined;
      const time = await getSimulatedTime(prisma, worldId);
      res.json({
        data: {
          simulatedNow: time.simulatedNow.toISOString(),
          wallNow: time.wallNow.toISOString(),
          offsetMinutes: time.offsetMinutes,
          timeScale: time.timeScale,
          phase: time.phase,
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

worldRouter.post(
  "/tick",
  requirePermission(PERMISSIONS.WORLD_WRITE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const worldId = typeof req.body?.worldId === "string" ? (req.body.worldId as string) : undefined;
      const result = await tickWorld(prisma, worldId);
      res.json({
        data: {
          worldId: result.world.id,
          timeOffsetMinutes: result.world.timeOffsetMinutes,
          simulatedNow: result.simulated.simulatedNow.toISOString(),
          phase: result.simulated.phase,
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

worldRouter.get(
  "/worlds",
  requirePermission(PERMISSIONS.WORLD_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const worlds = await listWorlds(prisma);
      res.json({ data: worlds, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

worldRouter.get(
  "/cities",
  requirePermission(PERMISSIONS.WORLD_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const worldId = typeof req.query.worldId === "string" ? req.query.worldId : undefined;
      const cities = worldId !== undefined ? await listCities(prisma, worldId) : [];
      res.json({ data: cities, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

worldRouter.get(
  "/districts",
  requirePermission(PERMISSIONS.WORLD_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const districts = await listDistricts(prisma, {
        ...(q.worldId !== undefined ? { worldId: q.worldId } : {}),
        ...(q.cityId !== undefined ? { cityId: q.cityId } : {}),
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
      });
      res.json({ data: districts, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const CreateDistrictSchema = z.object({
  cityId: z.string().min(1),
  name: z.string().min(1).max(120),
  kind: z.string().max(60).optional(),
  description: z.string().max(2000).optional().nullable(),
  geometry: z.record(z.string(), z.unknown()).optional(),
});

worldRouter.post(
  "/districts",
  requirePermission(PERMISSIONS.WORLD_WRITE),
  validate("body", CreateDistrictSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateDistrictSchema>;
      const district = await createDistrict(
        prisma,
        {
          cityId: body.cityId,
          name: body.name,
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.geometry !== undefined ? { geometry: body.geometry } : {}),
        },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
      );
      res.status(201).json({ data: district, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

worldRouter.get(
  "/locations",
  requirePermission(PERMISSIONS.WORLD_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const locations = await listLocations(prisma, {
        ...(q.worldId !== undefined ? { worldId: q.worldId } : {}),
        ...(q.cityId !== undefined ? { cityId: q.cityId } : {}),
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
      });
      res.json({ data: locations, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

worldRouter.get(
  "/locations/:id",
  requirePermission(PERMISSIONS.WORLD_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const detail = await getLocationDetail(prisma, req.params.id as string);
      res.json({ data: detail, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const MoveAgentSchema = z.object({
  agentId: z.string().min(1),
  toLocationId: z.string().min(1).nullable(),
  reason: z.string().max(500).optional(),
});

worldRouter.post(
  "/move-agent",
  requirePermission(PERMISSIONS.WORLD_WRITE),
  validate("body", MoveAgentSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof MoveAgentSchema>;
      const agent = await moveAgent(
        prisma,
        { agentId: body.agentId, toLocationId: body.toLocationId, reason: body.reason },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
      );
      res.json({ data: agent, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const CreateWorldSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  timeScale: z.number().int().min(1).max(100000).optional(),
});

worldRouter.post(
  "/worlds",
  requirePermission(PERMISSIONS.WORLD_WRITE),
  validate("body", CreateWorldSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateWorldSchema>;
      const world = await createWorld(prisma, body, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.status(201).json({ data: world, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const CreateCitySchema = z.object({
  worldId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  kind: z.string().max(60).optional(),
});

worldRouter.post(
  "/cities",
  requirePermission(PERMISSIONS.WORLD_WRITE),
  validate("body", CreateCitySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateCitySchema>;
      const city = await createCity(prisma, body, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.status(201).json({ data: city, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const CreateLocationSchema = z.object({
  cityId: z.string().min(1),
  name: z.string().min(1).max(120),
  kind: z.string().min(1).max(60),
  address: z.string().max(500).optional().nullable(),
  capacity: z.number().int().min(1).max(1000000).optional().nullable(),
  districtId: z.string().min(1).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

worldRouter.post(
  "/locations",
  requirePermission(PERMISSIONS.WORLD_WRITE),
  validate("body", CreateLocationSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateLocationSchema>;
      const location = await createLocation(
        prisma,
        {
          cityId: body.cityId,
          name: body.name,
          kind: body.kind,
          address: body.address ?? null,
          capacity: body.capacity ?? null,
          districtId: body.districtId ?? null,
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
      );
      res.status(201).json({ data: location, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
