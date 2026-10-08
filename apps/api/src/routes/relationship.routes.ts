/**
 * Relationship graph REST.
 *
 * Read paths expose the measured social graph. The write path records an
 * OBSERVED interaction only -- there is no endpoint that asserts trust or
 * affinity directly, because scores come from interaction history alone.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { listRelationships, getRelationship, recordInteraction } from "../../../../packages/agents/src/index.js";

export const relationshipRouter = Router();

relationshipRouter.use(authenticate, requirePermission(PERMISSIONS.AGENT_READ));

relationshipRouter.get(
  "/agents/:agentId",
  async (req: Request, res: Response, _next: NextFunction) => {
    const relationships = await listRelationships(prisma, req.params.agentId as string);
    res.json({ data: relationships, correlationId: getCorrelationId(req) });
  },
);

relationshipRouter.get(
  "/agents/:agentId/with/:targetAgentId",
  async (req: Request, res: Response, _next: NextFunction) => {
    const edge = await getRelationship(
      prisma,
      req.params.agentId as string,
      req.params.targetAgentId as string,
    );
    res.json({ data: edge, correlationId: getCorrelationId(req) });
  },
);

const ObserveSchema = z.object({
  sourceAgentId: z.string().min(1),
  targetAgentId: z.string().min(1),
  kind: z.enum(["CONVERSATION", "COLLABORATION", "CO_LOCATION", "OUTCOME"]),
  outcome: z.enum(["SUCCESS", "FAILURE"]).optional(),
  weight: z.number().int().min(1).max(5).optional(),
});

relationshipRouter.post(
  "/observe",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", ObserveSchema),
  async (req: Request, res: Response, _next: NextFunction) => {
    const body = ObserveSchema.parse(req.body);
    const edge = await recordInteraction(
      prisma,
      {
        sourceAgentId: body.sourceAgentId,
        targetAgentId: body.targetAgentId,
        kind: body.kind,
        outcome: body.outcome,
        weight: body.weight,
      },
      { actor: principalToActor(getPrincipal(req)), correlationId: getCorrelationId(req) },
    );
    res.status(201).json({ data: edge, correlationId: getCorrelationId(req) });
  },
);
