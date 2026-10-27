/**
 * Company scope for ids that arrive inside a request or a tool call.
 *
 * One place decides which keys name a company link and how an id is resolved
 * to the companies it belongs to, so the REST middleware (human callers) and
 * the tool executor (agent callers) cannot drift apart. A key the scope check
 * does not recognise is a key that can smuggle another company's id, which is
 * why matching is by suffix and plural, not by an exact list.
 */
import type { DbClient } from "../../database/src/index.js";
import { scopeAllows, type CompanyScope } from "./company-access.js";

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
export async function filterByScope<T>(db: DbClient, scope: CompanyScope, items: T[], pick: (item: T) => OwnerRef): Promise<T[]> {
  if (scope.all || items.length === 0) return items;
  const owners = items.map(pick);
  const workspaceIds = uniq(owners.map((o) => o.workspaceId));
  const workspaces = workspaceIds.length
    ? await db.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, agentId: true } })
    : [];
  const workspaceAgent = new Map(workspaces.map((w) => [w.id, w.agentId]));
  const agentIds = uniq([...owners.map((o) => o.agentId), ...workspaces.map((w) => w.agentId)]);
  const taskIds = uniq(owners.map((o) => o.taskId));
  const planIds = uniq(owners.map((o) => o.planId));
  const [agents, tasks, plans] = await Promise.all([
    agentIds.length ? db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, currentCompanyId: true } }) : [],
    taskIds.length ? db.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, companyId: true } }) : [],
    planIds.length ? db.plan.findMany({ where: { id: { in: planIds } }, select: { id: true, companyId: true } }) : [],
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

/**
 * Maps a body/query/argument key to the link it names, or null when it names none.
 * Prefixed (`currentCompanyId`, `parentTaskId`, `assigneeAgentId`) and plural
 * (`participantAgentIds`) spellings name the same link.
 */
export function linkForKey(key: string): keyof OwnerRef | null {
  const singular = key.endsWith("Ids") ? key.slice(0, -1) : key;
  if (singular === "companyId" || singular.endsWith("CompanyId")) return "companyId";
  if (singular === "taskId" || singular.endsWith("TaskId")) return "taskId";
  if (singular === "planId" || singular.endsWith("PlanId")) return "planId";
  if (singular === "workspaceId" || singular.endsWith("WorkspaceId")) return "workspaceId";
  if (singular === "agentId" || singular.endsWith("AgentId")) return "agentId";
  return null;
}

type Loader = (id: string) => Promise<OwnerRef | null>;

/**
 * Ids of rows that are not links themselves but belong to one: the loader
 * returns the row's links (null when it does not exist, leaving the 404 to
 * the handler). Matched like linkForKey: exact, prefixed or plural.
 */
function indirectLinks(db: DbClient): Array<{ suffix: string; load: Loader }> {
  return [
    {
      // Messages of a conversation are fed into an agent's prompt and its reply
      // is posted back, so a foreign conversation id is a read and a write.
      suffix: "conversationId",
      load: async (id) => {
        const row = await db.conversation.findUnique({ where: { id }, select: { companyId: true } });
        return row && { companyId: row.companyId };
      },
    },
    {
      suffix: "sessionId",
      load: async (id) =>
        db.agentSession.findUnique({ where: { id }, select: { agentId: true, taskId: true, workspaceId: true } }),
    },
    {
      suffix: "jobId",
      load: async (id) =>
        db.executionJob.findUnique({ where: { id }, select: { agentId: true, taskId: true, workspaceId: true } }),
    },
    {
      // Execution tools and query strings name the same job as `executionId`.
      suffix: "executionId",
      load: async (id) =>
        db.executionJob.findUnique({ where: { id }, select: { agentId: true, taskId: true, workspaceId: true } }),
    },
    {
      suffix: "factoryRunId",
      load: async (id) =>
        db.factoryRun.findUnique({ where: { id }, select: { companyId: true, taskId: true, workspaceId: true } }),
    },
    {
      suffix: "testRunId",
      load: async (id) =>
        db.testRun.findUnique({ where: { id }, select: { agentId: true, taskId: true, workspaceId: true } }),
    },
    {
      suffix: "trainingRunId",
      load: async (id) => db.trainingRun.findUnique({ where: { id }, select: { agentId: true } }),
    },
    {
      suffix: "approvalRequestId",
      load: async (id) => {
        const row = await db.approvalRequest.findUnique({ where: { id }, select: { companyId: true, taskId: true, requesterAgentId: true } });
        return row && { companyId: row.companyId, taskId: row.taskId, agentId: row.requesterAgentId };
      },
    },
    {
      suffix: "projectId",
      load: async (id) => db.project.findUnique({ where: { id }, select: { companyId: true } }),
    },
    {
      suffix: "departmentId",
      load: async (id) => db.department.findUnique({ where: { id }, select: { companyId: true } }),
    },
  ];
}

function indirectLoaderForKey(db: DbClient, key: string): Loader | null {
  const singular = key.endsWith("Ids") ? key.slice(0, -1) : key;
  const capitalised = (suffix: string): string => suffix.charAt(0).toUpperCase() + suffix.slice(1);
  const match = indirectLinks(db).find((link) => singular === link.suffix || singular.endsWith(capitalised(link.suffix)));
  return match?.load ?? null;
}

export interface ScopeRef {
  key: string;
  id: string;
  /** The links the id names: direct, or loaded from the row it points at. */
  owner: OwnerRef | (() => Promise<OwnerRef | null>);
}

/**
 * Every company/agent/task/plan/workspace id (and indirect id) found at the
 * top level of the given objects. Arrays of ids are checked element by element.
 */
export function collectRefs(db: DbClient, ...sources: unknown[]): ScopeRef[] {
  const refs: ScopeRef[] = [];
  for (const source of sources) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const link = linkForKey(key);
      const load = link === null ? indirectLoaderForKey(db, key) : null;
      if (link === null && load === null) continue;
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id !== "string" || id.length === 0) continue;
        refs.push({ key, id, owner: link !== null ? { [link]: id } : () => (load as Loader)(id) });
      }
    }
  }
  return refs;
}

/** The first reference the scope cannot see, or null when all are visible (or the row does not exist). */
export async function firstInvisibleRef(db: DbClient, scope: CompanyScope, refs: ScopeRef[]): Promise<ScopeRef | null> {
  if (scope.all) return null;
  for (const ref of refs) {
    const owner = typeof ref.owner === "function" ? await ref.owner() : ref.owner;
    if (owner === null) continue;
    const visible = await filterByScope(db, scope, [owner], (o) => o);
    if (visible.length === 0) return ref;
  }
  return null;
}
