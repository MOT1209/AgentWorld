/**
 * Company boundary for agent tool calls.
 *
 * Tool arguments are model output, so an id in them is as untrusted as an id in
 * a request body. The REST layer checks every company/agent/task/plan/workspace
 * id (and conversation, session, project... ids) against the caller's companies;
 * this applies the same rule, from the same code, to an agent caller: every
 * referenced row must belong to the agent's own company or to no company at all
 * (the shared world). An agent without a company therefore reaches shared rows only.
 *
 * Which company an agent is in is read from the database, never from the call
 * context, so a context that omits or misstates it cannot widen the scope.
 */
import type { DbClient } from "../../database/src/index.js";
import type { CompanyScope } from "../../security/src/company-access.js";
import { collectRefs, firstInvisibleRef, linkForKey, type ScopeRef } from "../../security/src/company-refs.js";

export async function agentCompanyScope(db: DbClient, agentId: string): Promise<CompanyScope> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { currentCompanyId: true } });
  return { all: false, companyIds: new Set(agent?.currentCompanyId ? [agent.currentCompanyId] : []) };
}

/**
 * The first id in `input` that names a row outside the agent's company, or null.
 * `allowForeignAgents` skips the agent-id keys for tools that declare
 * `crossCompanyAgentRefs` and enforce their own rule for them.
 */
export async function agentScopeViolation(
  db: DbClient,
  agentId: string,
  input: unknown,
  options: { allowForeignAgents: boolean },
): Promise<ScopeRef | null> {
  let refs = collectRefs(db, input);
  if (options.allowForeignAgents) refs = refs.filter((ref) => linkForKey(ref.key) !== "agentId");
  if (refs.length === 0) return null;
  return firstInvisibleRef(db, await agentCompanyScope(db, agentId), refs);
}
