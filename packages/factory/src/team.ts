/**
 * Team formation suggestions for the Software Factory.
 *
 * This module SUGGESTS; it never assigns. Assignment stays with Agent 1's
 * delegation engine (the Task Engine + capability matching in
 * packages/tasks and packages/orchestration), which this module only reads.
 * The factory records the suggestion on the run's github JSON (`team`) so
 * the operator can see who was considered before anyone is assigned.
 *
 * Ranking, in order:
 *   1. Skill overlap: requiredSkills intersected with the agent's declared
 *      skills + capabilities (both free-form JSON string arrays).
 *   2. Availability: IDLE/ONLINE agents first; WORKING/THINKING/WAITING next;
 *      OFFLINE/ERROR/PAUSED last.
 *   3. Workload: fewer active assigned tasks first.
 *   4. Reputation: higher standing breaks ties.
 *
 * Scores are advisory and fully explained in `reasons`.
 */
import type { DbClient } from "../../database/src/index.js";
import { validationError } from "../../shared/src/index.js";

export interface TeamSuggestionInput {
  requiredSkills?: string[];
  /** TaskType string, e.g. IMPLEMENTATION | TESTING | REVIEW. Advisory hint. */
  taskType?: string;
  companyId?: string | null;
  limit?: number;
}

export interface TeamCandidate {
  agentId: string;
  name: string;
  roleKey: string;
  score: number;
  skillOverlap: string[];
  availability: string;
  activeTasks: number;
  reputation: number;
  reasons: string[];
}

/** Task-type to skill-name hints. Advisory matching, never authoritative. */
const TASK_TYPE_SKILL_HINTS: Record<string, string[]> = {
  IMPLEMENTATION: ["code", "build", "implement", "develop", "software", "backend", "frontend"],
  TESTING: ["test", "qa", "quality", "e2e", "browser"],
  REVIEW: ["review", "audit", "quality"],
  PLANNING: ["plan", "architect", "design"],
  RESEARCH: ["research", "analysis", "investigate"],
  ANALYSIS: ["analysis", "research", "data"],
};

const ACTIVE_TASK_STATUSES = ["PLANNED", "ASSIGNED", "RUNNING", "WAITING_APPROVAL", "REVIEWING", "BLOCKED"];

const AVAILABILITY_RANK: Record<string, number> = {
  IDLE: 0,
  ONLINE: 0,
  THINKING: 1,
  WORKING: 1,
  WAITING: 1,
  TRAVELING: 2,
  RESTING: 2,
  SOCIALIZING: 2,
  SLEEPING: 3,
  PAUSED: 4,
  OFFLINE: 5,
  ERROR: 6,
};

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Ranked team candidates. Read-only: no tasks are assigned, no state changes,
 * no events. Returns an empty list (with a note) when no active agent exists.
 */
export async function suggestTeam(
  db: DbClient,
  input: TeamSuggestionInput,
): Promise<{ candidates: TeamCandidate[]; note: string | null }> {
  const required = (input.requiredSkills ?? []).map((skill) => skill.toLowerCase()).filter((skill) => skill !== "");
  const hints = input.taskType !== undefined
    ? (TASK_TYPE_SKILL_HINTS[input.taskType.toUpperCase()] ?? [])
    : [];
  const wanted = [...new Set([...required, ...hints])];
  if (wanted.length === 0) throw validationError("suggestTeam needs requiredSkills or a known taskType");

  const agents = await db.agent.findMany({
    where: {
      isActive: true,
      ...(input.companyId !== undefined && input.companyId !== null ? { currentCompanyId: input.companyId } : {}),
    },
    select: { id: true, name: true, roleKey: true, skills: true, capabilities: true, reputation: true },
    take: 100,
  });
  if (agents.length === 0) {
    return { candidates: [], note: "No active agents to suggest from" };
  }

  const states = await db.agentState.findMany({
    where: { agentId: { in: agents.map((agent) => agent.id) } },
    select: { agentId: true, state: true },
  });
  const stateByAgent = new Map(states.map((state) => [state.agentId, state.state]));

  const workload = await db.task.groupBy({
    by: ["assigneeAgentId"],
    where: { assigneeAgentId: { in: agents.map((agent) => agent.id) }, status: { in: ACTIVE_TASK_STATUSES } },
    _count: { id: true },
  });
  const loadByAgent = new Map(workload.map((row) => [row.assigneeAgentId ?? "", row._count.id]));

  const candidates: TeamCandidate[] = agents.map((agent) => {
    const declared = [
      ...parseStringArray(agent.skills),
      ...parseStringArray(agent.capabilities),
    ].map((skill) => skill.toLowerCase());
    const overlap = wanted.filter((skill) => declared.some((have) => have.includes(skill) || skill.includes(have)));
    const availability = stateByAgent.get(agent.id) ?? "OFFLINE";
    const activeTasks = loadByAgent.get(agent.id) ?? 0;
    const availabilityPenalty = (AVAILABILITY_RANK[availability] ?? 5) * 10;
    const score = overlap.length * 100 - availabilityPenalty - activeTasks * 5 + Math.min(agent.reputation, 100);
    const reasons: string[] = [];
    if (overlap.length > 0) reasons.push(`skill overlap: ${overlap.join(", ")}`);
    else reasons.push("no declared skill overlap (generalist fallback)");
    reasons.push(`availability: ${availability}`);
    reasons.push(`active tasks: ${activeTasks}`);
    reasons.push(`reputation: ${agent.reputation}`);
    return {
      agentId: agent.id,
      name: agent.name,
      roleKey: agent.roleKey,
      score,
      skillOverlap: overlap,
      availability,
      activeTasks,
      reputation: agent.reputation,
      reasons,
    };
  });
  candidates.sort((a, b) => b.score - a.score);

  const limit = input.limit ?? 5;
  return { candidates: candidates.slice(0, Math.max(1, Math.min(limit, 20))), note: null };
}
