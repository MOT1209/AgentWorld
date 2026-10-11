/**
 * Company scope for resources that reach a company indirectly.
 *
 * A row can name its company directly (`companyId`) or through what it
 * belongs to: an agent (its current company), a task, a plan or a workspace
 * (via the workspace's agent). A row is visible only when EVERY company it
 * links to is visible; links with no company are the shared world. The rules
 * themselves live in packages/security/src/company-access.ts.
 */
import type { NextFunction, Request, Response, Router } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { companyScope, scopeAllows, type CompanyScope } from "../../../../packages/security/src/company-access.js";
import { notFound } from "../../../../packages/shared/src/index.js";
import { getPrincipal } from "./authenticate.js";

export interface OwnerRef {
  companyId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
  planId?: string | null;
  workspaceId?: string | null;
}

const uniq = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))];

/** Keeps the items whose every linked company is visible. Batched: one query per link type. */
export async function filterByScope<T>(scope: CompanyScope, items: T[], pick: (item: T) => OwnerRef): Promise<T[]> {
  if (scope.all || items.length === 0) return items;
  const owners = items.map(pick);
  const workspaceIds = uniq(owners.map((o) => o.workspaceId));
  const workspaces = workspaceIds.length
    ? await prisma.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, agentId: true } })
    : [];
  const workspaceAgent = new Map(workspaces.map((w) => [w.id, w.agentId]));
  const agentIds = uniq([...owners.map((o) => o.agentId), ...workspaces.map((w) => w.agentId)]);
  const taskIds = uniq(owners.map((o) => o.taskId));
  const planIds = uniq(owners.map((o) => o.planId));
  const [agents, tasks, plans] = await Promise.all([
    agentIds.length ? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, currentCompanyId: true } }) : [],
    taskIds.length ? prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, companyId: true } }) : [],
    planIds.length ? prisma.plan.findMany({ where: { id: { in: planIds } }, select: { id: true, companyId: true } }) : [],
  ]);
  const agentCompany = new Map(agents.map((a) => [a.id, a.currentCompanyId]));
  const taskCompany = new Map(tasks.map((t) => [t.id, t.companyId]));
  const planCompany = new Map(plans.map((p) => [p.id, p.companyId]));
  return items.filter((_item, index) => {
    const o = owners[index] ?? {};
    const viaWorkspace = o.workspaceId ? workspaceAgent.get(o.workspaceId) : undefined;
    const links = [
      o.companyId,
      o.agentId ? agentCompany.get(o.agentId) : null,
      viaWorkspace ? agentCompany.get(viaWorkspace) : null,
      o.taskId ? taskCompany.get(o.taskId) : null,
      o.planId ? planCompany.get(o.planId) : null,
    ];
    return links.every((companyId) => scopeAllows(scope, companyId));
  });
}

export async function requestScope(req: Request): Promise<CompanyScope> {
  return companyScope(prisma, getPrincipal(req));
}

/** Filters a list for the requesting principal. */
export async function scoped<T>(req: Request, items: T[], pick: (item: T) => OwnerRef): Promise<T[]> {
  return filterByScope(await requestScope(req), items, pick);
}

/** Links for an event/activity row: its company, its agent actor, and its target. */
export function logOwnerRef(row: {
  companyId?: string | null;
  actorType: string;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
}): OwnerRef & { extraAgentId?: string | null } {
  const ref: OwnerRef & { extraAgentId?: string | null } = { companyId: row.companyId ?? null };
  if (row.actorType === "AGENT" && row.actorId) ref.agentId = row.actorId;
  const id = row.targetId;
  if (id) {
    if (row.targetType === "Company") ref.companyId = ref.companyId ?? id;
    else if (row.targetType === "Agent") ref.extraAgentId = id;
    else if (row.targetType === "Task") ref.taskId = id;
    else if (row.targetType === "Plan") ref.planId = id;
    else if (row.targetType === "Workspace") ref.workspaceId = id;
  }
  return ref;
}

/** Filters log rows by their actor link AND their target link. */
export async function scopedLogs<T extends Parameters<typeof logOwnerRef>[0]>(scope: CompanyScope, rows: T[]): Promise<T[]> {
  if (scope.all) return rows;
  const byActorAndRest = await filterByScope(scope, rows, (row) => {
    const { extraAgentId: _ignored, ...rest } = logOwnerRef(row);
    return rest;
  });
  return filterByScope(scope, byActorAndRest, (row) => ({ agentId: logOwnerRef(row).extraAgentId ?? null }));
}

/**
 * Maps a body/query key to the link it names, or null when it names none.
 * Prefixed (`currentCompanyId`, `parentTaskId`, `assigneeAgentId`) and plural
 * (`participantAgentIds`) spellings name the same link: a key the scope check
 * does not recognise is a key that can smuggle another company's id.
 */
function linkForKey(key: string): keyof OwnerRef | null {
  const singular = key.endsWith("Ids") ? key.slice(0, -1) : key;
  if (singular === "companyId" || singular.endsWith("CompanyId")) return "companyId";
  if (singular === "taskId" || singular.endsWith("TaskId")) return "taskId";
  if (singular === "planId" || singular.endsWith("PlanId")) return "planId";
  if (singular === "workspaceId" || singular.endsWith("WorkspaceId")) return "workspaceId";
  if (singular === "agentId" || singular.endsWith("AgentId")) return "agentId";
  return null;
}

/**
 * Router middleware: every company/agent/task/plan/workspace id that arrives
 * in the body or query string must be visible, so a caller can neither file
 * work into another company nor filter a list by another company's ids.
 * Arrays of ids (`participantAgentIds`, repeated query keys) are checked
 * element by element.
 */
export function scopeRefs(req: Request, _res: Response, next: NextFunction): void {
  const refs: Array<{ owner: OwnerRef; key: string; id: string }> = [];
  for (const source of [req.body, req.query] as unknown[]) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const link = linkForKey(key);
      if (link === null) continue;
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id === "string" && id.length > 0) refs.push({ owner: { [link]: id }, key, id });
      }
    }
  }
  if (refs.length === 0) {
    next();
    return;
  }
  void (async () => {
    const scope = await requestScope(req);
    if (scope.all) return;
    for (const ref of refs) {
      const visible = await filterByScope(scope, [ref.owner], (o) => o);
      if (visible.length === 0) throw notFound(ref.key.replace(/Ids?$/, ""), ref.id);
    }
  })().then(() => next(), next);
}

/**
 * Registers a param hook: `load(id)` returns the row's links (null when the
 * row does not exist, leaving the 404 to the handler). An invisible row is a
 * 404 too, so ids cannot be probed across companies.
 */
export function scopeParam(
  router: Router,
  param: string,
  resource: string,
  load: (id: string) => Promise<OwnerRef | null>,
): void {
  router.param(param, (req: Request, _res: Response, next: NextFunction, id: string): void => {
    void (async () => {
      const owner = await load(id);
      if (owner === null) return;
      const visible = await scoped(req, [owner], (o) => o);
      if (visible.length === 0) throw notFound(resource, id);
    })().then(() => next(), next);
  });
}

/** Common loaders. */
export const owners = {
  company: async (id: string): Promise<OwnerRef | null> => ({ companyId: id }),
  agent: async (id: string): Promise<OwnerRef | null> => ({ agentId: id }),
  task: async (id: string): Promise<OwnerRef | null> => ({ taskId: id }),
};
