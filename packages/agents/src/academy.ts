/**
 * Academy -- measured training, never self-declared skill.
 *
 * A training run is a lifecycle over one skill of one agent: start, evaluate,
 * and only then (if passed) widen the agent's declared skills. The evaluator
 * is named as data and produces a score plus feedback; the run stores both,
 * so every claim "this agent is now trained in X" traces to a scored row.
 * Numeric skill levels from the simulation's XP curve stay authoritative --
 * Academy owns the lifecycle and the evidence, not the levels.
 */
import { newCorrelationId, toJsonArray, validationError } from "../../shared/src/index.js";
import type { ActorRef } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { TrainingRun } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";

export interface AcademyContext {
  actor: ActorRef;
  correlationId?: string;
}

export interface StartTrainingInput {
  agentId: string;
  skillName: string;
  evaluator?: string;
  passingScore?: number;
}

const CLAMP = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export async function startTrainingRun(
  db: DbClient,
  input: StartTrainingInput,
  ctx: AcademyContext,
): Promise<TrainingRun> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const agent = await db.agent.findUnique({ where: { id: input.agentId }, select: { id: true } });
  if (agent === null) throw validationError(`Agent '${input.agentId}' does not exist`);
  if (input.skillName.trim() === "") throw validationError("skillName is required");

  return db.trainingRun.create({
    data: {
      agentId: input.agentId,
      skillName: input.skillName.trim(),
      evaluator: input.evaluator?.trim() || "quiz",
      passingScore: input.passingScore === undefined ? 70 : CLAMP(input.passingScore, 0, 100),
      correlationId,
    },
  });
}

export interface EvaluationInput {
  /** 0-100, produced by the named evaluator. */
  score: number;
  feedback?: string;
}

/**
 * Record an evaluation outcome for a RUNNING run. Terminal: a run evaluates
 * once. A passing score grants the skill to the agent's declared skills;
 * failing keeps the run as evidence only.
 */
export async function evaluateTrainingRun(
  db: DbClient,
  trainingRunId: string,
  input: EvaluationInput,
  ctx: AcademyContext,
): Promise<TrainingRun> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const run = await db.trainingRun.findUnique({ where: { id: trainingRunId } });
  if (run === null) throw validationError(`TrainingRun '${trainingRunId}' does not exist`);
  if (run.status !== "RUNNING") {
    throw validationError(`TrainingRun '${trainingRunId}' is already ${run.status}`);
  }

  const score = CLAMP(Math.round(input.score), 0, 100);
  const passed = score >= run.passingScore;

  const evaluated = await db.trainingRun.update({
    where: { id: trainingRunId },
    data: {
      status: "EVALUATED",
      score,
      feedback: input.feedback ?? null,
      finishedAt: new Date(),
    },
  });

  if (passed) {
    const agent = await db.agent.findUnique({
      where: { id: run.agentId },
      select: { skills: true },
    });
    // Tolerate malformed rows: a corrupt skills column degrades to empty
    // rather than crashing the evaluation with a SyntaxError.
    const skills: string[] = agent ? toJsonArray(agent.skills) : [];
    if (!skills.includes(run.skillName)) {
      skills.push(run.skillName);
      await db.agent.update({ where: { id: run.agentId }, data: { skills: JSON.stringify(skills) } });
    }
  }

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.EVALUATION_RECORDED,
    actor: ctx.actor,
    correlationId,
    targetType: "TrainingRun",
    targetId: evaluated.id,
    payload: {
      trainingRunId: evaluated.id,
      agentId: run.agentId,
      skillName: run.skillName,
      score,
      passed,
      feedback: input.feedback ?? "",
    },
  });

  return evaluated;
}

/** Terminal failure (e.g. the training itself crashed). Evidence, not score. */
export async function failTrainingRun(
  db: DbClient,
  trainingRunId: string,
  reason: string,
  ctx: AcademyContext,
): Promise<TrainingRun> {
  const run = await db.trainingRun.findUnique({ where: { id: trainingRunId } });
  if (run === null) throw validationError(`TrainingRun '${trainingRunId}' does not exist`);
  if (run.status !== "RUNNING") {
    throw validationError(`TrainingRun '${trainingRunId}' is already ${run.status}`);
  }

  const failed = await db.trainingRun.update({
    where: { id: trainingRunId },
    data: { status: "FAILED", feedback: reason, finishedAt: new Date() },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.AGENT_TRAINED,
    actor: ctx.actor,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "TrainingRun",
    targetId: failed.id,
    payload: {
      trainingRunId: failed.id,
      agentId: run.agentId,
      skillName: run.skillName,
      status: "FAILED",
      score: null,
    },
  });

  return failed;
}

export async function listTrainingRuns(
  db: DbClient,
  agentId: string,
  query: { skillName?: string; status?: string } = {},
): Promise<TrainingRun[]> {
  return db.trainingRun.findMany({
    where: {
      agentId,
      ...(query.skillName !== undefined ? { skillName: query.skillName } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}
