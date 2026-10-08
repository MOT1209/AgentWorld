/**
 * Academy and evolution tools. `academy.train` runs the scored training
 * lifecycle: only a passed evaluation grants a skill, and the grant widens
 * the agent's declared skills -- a standing change, so evaluating is gated
 * behind AGENT_MODIFY (human-only). Agents may start runs and read evidence;
 * `agent.evolution` recomputes standing from measured history and is
 * read-only on the caller's side.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { validationError } from "../../../shared/src/index.js";
import {
  startTrainingRun,
  evaluateTrainingRun,
  listTrainingRuns,
  evolveReputation,
} from "../../../agents/src/index.js";
import type { ToolDefinition } from "../types.js";

export const academyTrainTool: ToolDefinition<{
  agentId?: string;
  skillName?: string;
  trainingRunId?: string;
  evaluator?: string;
  passingScore?: number;
  score?: number;
  feedback?: string;
}> = {
  name: "academy.train",
  description:
    "Start a training run (agentId + skillName), or evaluate a run (trainingRunId + score). " +
    "A passed evaluation grants the skill; a failed one is recorded as evidence only. " +
    "Evaluating requires human authority because it widens the agent's declared skills.",
  inputSchema: z.object({
    agentId: z.string().optional().describe("Agent to train (start a run)"),
    skillName: z.string().optional().describe("Skill the run trains"),
    trainingRunId: z.string().optional().describe("Existing run to evaluate"),
    evaluator: z.string().optional().describe("Evaluator name, e.g. quiz | task-replay | rubric-review"),
    passingScore: z.number().int().min(0).max(100).optional().describe("Pass bar, default 70"),
    score: z.number().int().min(0).max(100).optional().describe("Evaluation result 0-100"),
    feedback: z.string().max(2000).optional(),
  }),
  requiredPermission: PERMISSIONS.AGENT_MODIFY,
  risk: "MEDIUM",
  async execute(context, input) {
    if (input.trainingRunId !== undefined) {
      if (input.score === undefined) throw validationError("score is required when evaluating a run");
      const run = await evaluateTrainingRun(
        context.db,
        input.trainingRunId,
        { score: input.score, feedback: input.feedback },
        { actor: context.actor, correlationId: context.correlationId },
      );
      const granted = (run.score ?? 0) >= run.passingScore;
      return {
        data: { run, skillGranted: granted },
        summary: granted
          ? `Evaluated ${run.score}/${run.passingScore} -- skill '${run.skillName}' granted`
          : `Evaluated ${run.score}/${run.passingScore} -- skill not granted`,
      };
    }
    const agentId = input.agentId ?? context.agentId;
    if (agentId === undefined || input.skillName === undefined) {
      throw validationError("academy.train needs agentId + skillName, or trainingRunId + score");
    }
    const run = await startTrainingRun(
      context.db,
      {
        agentId,
        skillName: input.skillName,
        evaluator: input.evaluator,
        passingScore: input.passingScore,
      },
      { actor: context.actor, correlationId: context.correlationId },
    );
    return {
      data: { run },
      summary: `Training run started for '${run.skillName}' (passing >= ${run.passingScore})`,
    };
  },
};

export const academyListTool: ToolDefinition<{ agentId?: string; skillName?: string; status?: string }> = {
  name: "academy.list",
  description: "List an agent's training runs -- the evidence behind every granted skill.",
  inputSchema: z.object({
    agentId: z.string().optional().describe("Defaults to the calling agent"),
    skillName: z.string().optional(),
    status: z.string().optional().describe("RUNNING | EVALUATED | FAILED | CANCELLED"),
  }),
  requiredPermission: PERMISSIONS.AGENT_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = input.agentId ?? context.agentId;
    if (agentId === undefined) throw validationError("academy.list requires an agent");
    const runs = await listTrainingRuns(context.db, agentId, {
      skillName: input.skillName,
      status: input.status,
    });
    return { data: { agentId, count: runs.length, runs } };
  },
};

export const agentEvolutionTool: ToolDefinition<{ agentId?: string }> = {
  name: "agent.evolution",
  description:
    "Recompute reputation from measured history (tasks, reviews, executions). Reputation moves " +
    "only through evidence, at most 5 points per pass, and every change is auditable.",
  inputSchema: z.object({
    agentId: z.string().optional().describe("Defaults to the calling agent"),
  }),
  requiredPermission: PERMISSIONS.AGENT_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = input.agentId ?? context.agentId;
    if (agentId === undefined) throw validationError("agent.evolution requires an agent");
    const result = await evolveReputation(context.db, agentId, {
      actor: context.actor,
      correlationId: context.correlationId,
    });
    return {
      data: {
        agentId: result.agentId,
        fromReputation: result.fromReputation,
        toReputation: result.toReputation,
        delta: result.delta,
        reason: result.reason,
        performance: result.performance,
      },
      summary:
        result.delta === 0
          ? "Reputation unchanged (insufficient or neutral evidence)"
          : `Reputation ${result.fromReputation} -> ${result.toReputation}: ${result.reason}`,
    };
  },
};

export const academyTools = [academyTrainTool, academyListTool, agentEvolutionTool];
