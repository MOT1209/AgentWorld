/**
 * Hierarchy sync — materializes role reporting lines into AgentHierarchy rows.
 *
 * `hierarchy.ts` stays pure (graph math, no database). This module is the
 * impure counterpart: it reads live agents + registered roles and reconciles
 * the rows, so the table is system-managed truth rather than a second,
 * silently stale source. Rules:
 *
 *  - One row per (live subordinate agent, live supervisor agent, kind).
 *  - Kind is STRATEGIC when the supervisor role is PLANNER (plans flow up),
 *    OPERATIONAL otherwise.
 *  - Rows for dead links (role changed, agent deactivated) are pruned.
 *  - Root roles (no reportsTo) produce no rows: their escalations go human.
 *
 * Call after role/agent changes (seed does). Never hand-edit the rows.
 */
import type { DbClient } from "../../database/src/index.js";
import { roleProfiles } from "./role-profiles.js";

export interface HierarchySyncResult {
  created: number;
  removed: number;
}

export async function syncHierarchyFromRoles(db: DbClient): Promise<HierarchySyncResult> {
  const desired: Array<{ subordinateAgentId: string; supervisorAgentId: string; kind: string }> = [];

  for (const profile of roleProfiles.list()) {
    const supervisorRole = profile.reportsTo;
    if (supervisorRole === undefined) continue;
    const subordinates = await db.agent.findMany({
      where: { roleKey: profile.roleKey, isActive: true },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (subordinates.length === 0) continue;
    const supervisors = await db.agent.findMany({
      where: { roleKey: supervisorRole, isActive: true },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (supervisors.length === 0) continue;
    const kind = supervisorRole === "PLANNER" ? "STRATEGIC" : "OPERATIONAL";
    for (const sub of subordinates) {
      for (const sup of supervisors) {
        if (sub.id === sup.id) continue;
        desired.push({ subordinateAgentId: sub.id, supervisorAgentId: sup.id, kind });
      }
    }
  }

  let created = 0;
  const wanted = new Set(desired.map((d) => `${d.subordinateAgentId}|${d.supervisorAgentId}|${d.kind}`));
  for (const link of desired) {
    const existing = await db.agentHierarchy.findUnique({
      where: {
        subordinateAgentId_supervisorAgentId_kind: {
          subordinateAgentId: link.subordinateAgentId,
          supervisorAgentId: link.supervisorAgentId,
          kind: link.kind,
        },
      },
    });
    if (existing === null) {
      await db.agentHierarchy.create({ data: link });
      created += 1;
    }
  }

  const stale = await db.agentHierarchy.findMany({ select: { id: true, subordinateAgentId: true, supervisorAgentId: true, kind: true } });
  const staleIds = stale
    .filter((row) => !wanted.has(`${row.subordinateAgentId}|${row.supervisorAgentId}|${row.kind}`))
    .map((row) => row.id);
  let removed = 0;
  for (const id of staleIds) {
    await db.agentHierarchy.delete({ where: { id } });
    removed += 1;
  }

  return { created, removed };
}
