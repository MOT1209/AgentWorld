/**
 * Academy and evolution REST.
 *
 * Training runs are evidence: starting one needs agent read, but EVALUATING
 * (which grants a skill) and failing a run require agent-modify authority --
 * skill widening never happens through an endpoint an unprivileged agent
 * can call. Evolution recomputes standing from measured history only.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import { authenticate, getPrincipal } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import {
  startTrainingRun,
  evaluateTrainingRun,
  failTrainingRun,
  listTrainingRuns,
  evolveReputation,
  evolveCompanyReputations,
} from "../../../../packages/agents/src/index.js";

export const academyRouter = Router();

academyRouter.use(authenticate);

const StartSchema = z.object({
  agentId: z.string().min(1),
  skillName: z.string().min(1).max(120),
  evaluator: z.string().min(1).max(60).optional(),
  passingScore: z.number().int().min(0).max(100).optional(),
});

const EvaluateSchema = z.object({
  score: z.number().int().min(0).max(100),
  feedback: z.string().max(2000).optional(),
});

const FailSchema = z.object({ reason: z.string().min(1).max(2000) });

const ListQuerySchema = z.object({
  skillName: z.string().max(120).optional(),
  status: z.enum(["RUNNING", "EVALUATED", "FAILED", "CANCELLED"]).optional(),
});

academyRouter.post(
  "/runs",
  requirePermission(PERMISSIONS.AGENT_READ),
  validate("body", StartSchema),
  async (req: Request, res: Response, _next: NextFunction) => {
    const body = req.body as unknown as z.infer<typeof StartSchema>;
    const run = await startTrainingRun(
      prisma,
      body,
      { actor: principalToActor(getPrincipal(req)), correlationId: getCorrelationId(req) },
    );
    res.status(201).json({ data: run, correlationId: getCorrelationId(req) });
  },
);

academyRouter.post(
  "/runs/:id/evaluate",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", EvaluateSchema),
  async (req: Request, res: Response, _next: NextFunction) => {
    const body = req.body as unknown as z.infer<typeof EvaluateSchema>;
    const run = await evaluateTrainingRun(
      prisma,
      req.params.id as string,
      body,
      { actor: principalToActor(getPrincipal(req)), correlationId: getCorrelationId(req) },
    );
    res.json({ data: run, correlationId: getCorrelationId(req) });
  },
);

academyRouter.post(
  "/runs/:id/fail",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", FailSchema),
  async (req: Request, res: Response, _next: NextFunction) => {
    const body = req.body as unknown as z.infer<typeof FailSchema>;
    const run = await failTrainingRun(
      prisma,
      req.params.id as string,
      body.reason,
      { actor: principalToActor(getPrincipal(req)), correlationId: getCorrelationId(req) },
    );
    res.json({ data: run, correlationId: getCorrelationId(req) });
  },
);

academyRouter.get(
  "/agents/:agentId/runs",
  requirePermission(PERMISSIONS.AGENT_READ),
  validate("query", ListQuerySchema),
  async (req: Request, res: Response, _next: NextFunction) => {
    const query = req.query as unknown as z.infer<typeof ListQuerySchema>;
    const runs = await listTrainingRuns(prisma, req.params.agentId as string, query);
    res.json({
      data: { agentId: req.params.agentId, count: runs.length, runs },
      correlationId: getCorrelationId(req),
    });
  },
);

academyRouter.post(
  "/agents/:agentId/evolve",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, _next: NextFunction) => {
    const result = await evolveReputation(
      prisma,
      req.params.agentId as string,
      { actor: principalToActor(getPrincipal(req)), correlationId: getCorrelationId(req) },
    );
    res.json({ data: result, correlationId: getCorrelationId(req) });
  },
);

academyRouter.post(
  "/companies/:companyId/evolve",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, _next: NextFunction) => {
    const results = await evolveCompanyReputations(
      prisma,
      req.params.companyId as string,
      { actor: principalToActor(getPrincipal(req)), correlationId: getCorrelationId(req) },
    );
    res.json({
      data: { companyId: req.params.companyId, agents: results },
      correlationId: getCorrelationId(req),
    });
  },
);
