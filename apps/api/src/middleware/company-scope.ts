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
import { companyScope, type CompanyScope } from "../../../../packages/security/src/company-access.js";
import {
  collectRefs,
  filterByScope as filterByScopeIn,
  firstInvisibleRef,
  type OwnerRef,
} from "../../../../packages/security/src/company-refs.js";
import { notFound } from "../../../../packages/shared/src/index.js";
import { getPrincipal } from "./authenticate.js";

export type { OwnerRef };

/** Keeps the items whose every linked company is visible. Batched: one query per link type. */
export async function filterByScope<T>(scope: CompanyScope, items: T[], pick: (item: T) => OwnerRef): Promise<T[]> {
  return filterByScopeIn(prisma, scope, items, pick);
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
 * Router middleware: every company/agent/task/plan/workspace id that arrives
 * in the body or query string must be visible, so a caller can neither file
 * work into another company nor filter a list by another company's ids.
 * Arrays of ids (`participantAgentIds`, repeated query keys) are checked
 * element by element; ids in INDIRECT_LINKS are checked through the row
 * they name. The key rules live in packages/security/src/company-refs.ts,
 * shared with the tool executor.
 */
export function scopeRefs(req: Request, _res: Response, next: NextFunction): void {
  const refs = collectRefs(prisma, req.body, req.query);
  if (refs.length === 0) {
    next();
    return;
  }
  void (async () => {
    const scope = await requestScope(req);
    if (scope.all) return;
    const hidden = await firstInvisibleRef(prisma, scope, refs);
    if (hidden !== null) throw notFound(hidden.key.replace(/Ids?$/, ""), hidden.id);
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
