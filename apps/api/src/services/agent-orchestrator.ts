import type { Request } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { runAgent, type AgentRunInput } from "../../../../packages/agents/src/runtime.js";
import { invoker, getCompositionRoot } from "./composition-root.js";
import { getCorrelationId } from "../middleware/correlation.js";

export async function orchestrateAgentRun(
  input: Omit<AgentRunInput, "correlationId">,
  req: Request,
): Promise<Awaited<ReturnType<typeof runAgent>>> {
  const correlationId = getCorrelationId(req);
  const { providerRegistry } = getCompositionRoot();
  return runAgent({ ...input, correlationId }, { db: prisma, invoker, providerRegistry });
}
