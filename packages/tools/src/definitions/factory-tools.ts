/**
 * Software Factory tools -- the agent-side interface to the pipeline.
 *
 * The pipeline itself is state-machine driven and bounded; these tools only
 * create runs, advance one stage at a time, inspect, and (for the human only)
 * merge. `factory.merge` is ALWAYS_APPROVE: no agent can ever merge a PR.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import type { ToolDefinition } from "../types.js";
import {
  startFactoryRun,
  advanceFactoryRun,
  listFactoryRuns,
  GithubClient,
} from "../../../factory/src/index.js";

const inspect = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

function clientFromContext(): GithubClient {
  return new GithubClient();
}

export const factoryStartTool: ToolDefinition<{
  repoUrl: string;
  companyId: string;
  instruction?: string;
  maxFixAttempts?: number;
}> = {
  name: "factory.start",
  description: "Start a Software Factory run: analyze a GitHub repository, then plan, build, test and review through the bounded pipeline.",
  inputSchema: z.object({
    repoUrl: z.string().max(300).regex(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/),
    companyId: z.string().max(100),
    instruction: z.string().max(2_000).optional(),
    maxFixAttempts: z.number().int().min(1).max(10).optional(),
  }),
  requiredPermission: PERMISSIONS.FACTORY_RUN,
  risk: "MEDIUM",
  async execute(context, input) {
    const run = await startFactoryRun(context.db, {
      repoUrl: input.repoUrl,
      companyId: input.companyId,
      actor: context.actor,
      correlationId: context.correlationId,
      ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
      ...(input.maxFixAttempts !== undefined ? { maxFixAttempts: input.maxFixAttempts } : {}),
      workspaceId: null,
    });
    return {
      data: { factoryRunId: run.id, status: run.status, stage: run.currentStage },
      summary: `Factory run ${run.id} started for ${input.repoUrl}`,
    };
  },
};

export const factoryAdvanceTool: ToolDefinition<{ factoryRunId: string }> = {
  name: "factory.advance",
  description: "Advance a factory run by exactly one pipeline stage (intake -> analyze -> plan -> build -> test -> review -> approval gate).",
  inputSchema: z.object({ factoryRunId: z.string().max(100) }),
  requiredPermission: PERMISSIONS.FACTORY_RUN,
  risk: "MEDIUM",
  async execute(context, input) {
    const run = await advanceFactoryRun(context.db, input.factoryRunId, clientFromContext());
    return {
      data: {
        factoryRunId: run.id,
        stage: run.currentStage,
        analysis: inspect(run.analysis),
        plan: inspect(run.plan),
        github: inspect(run.github),
        stats: inspect(run.stats),
      },
      summary: `Factory run ${run.id} advanced to ${run.currentStage}`,
    };
  },
};

export const factoryGetTool: ToolDefinition<{ factoryRunId: string }> = {
  name: "factory.get",
  description: "Inspect one factory run: stage, analysis report, plan, GitHub coordinates and stats.",
  inputSchema: z.object({ factoryRunId: z.string().max(100) }),
  requiredPermission: PERMISSIONS.FACTORY_READ,
  risk: "LOW",
  async execute(context, input) {
    const run = await context.db.factoryRun.findUnique({ where: { id: input.factoryRunId } });
    if (run === null) throw new Error(`FactoryRun '${input.factoryRunId}' not found`);
    return {
      data: {
        id: run.id,
        repoUrl: run.repoUrl,
        stage: run.currentStage,
        analysis: inspect(run.analysis),
        plan: inspect(run.plan),
        github: inspect(run.github),
        stats: inspect(run.stats),
        createdAt: run.createdAt,
      },
      summary: `Factory run ${run.id}: ${run.currentStage}`,
    };
  },
};

export const factoryListTool: ToolDefinition<{ companyId?: string }> = {
  name: "factory.list",
  description: "List recent factory runs.",
  inputSchema: z.object({ companyId: z.string().max(100).optional() }),
  requiredPermission: PERMISSIONS.FACTORY_READ,
  risk: "LOW",
  async execute(context, input) {
    const runs = await listFactoryRuns(context.db, input.companyId);
    return {
      data: {
        runs: runs.map((run) => ({ id: run.id, repoUrl: run.repoUrl, stage: run.currentStage, createdAt: run.createdAt })),
      },
      summary: `${runs.length} factory runs`,
    };
  },
};

export const factoryMergeTool: ToolDefinition<{ factoryRunId: string }> = {
  name: "factory.merge",
  description:
    "HUMAN ONLY. Merge the pull request produced by a factory run. This action is always held for explicit human approval; an agent calling it will be refused.",
  inputSchema: z.object({ factoryRunId: z.string().max(100) }),
  requiredPermission: PERMISSIONS.FACTORY_RUN,
  risk: "CRITICAL",
  humanOnly: true,
  approvalPolicy: () => ({
    risk: "CRITICAL" as const,
    reason: "Merging a pull request publishes the factory's work; a human decides.",
  }),
  async execute(context, input) {
    const { approveFactoryRun } = await import("../../../factory/src/index.js");
    // This tool is humanOnly: ToolExecutor refuses agent callers before the
    // handler runs, so the actor here is always a user principal.
    const actor = { actorType: "USER" as const, actorId: context.actor.actorId ?? "", actorName: context.actor.actorName };
    const run = await approveFactoryRun(context.db, input.factoryRunId, {
      actor,
      client: clientFromContext(),
    });
    return {
      data: { factoryRunId: run.id, stage: run.currentStage, github: inspect(run.github) },
      summary: `Factory run ${run.id} completed`,
    };
  },
};

export const factoryTools = [factoryStartTool, factoryAdvanceTool, factoryGetTool, factoryListTool, factoryMergeTool];
