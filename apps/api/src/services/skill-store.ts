/**
 * Skill store: process-wide singletons for the external skills ecosystem.
 *
 * The catalog, usage tracker, and skill requests live here so every route
 * shares one implementation. Persistence across restarts is a file catalog
 * + lockfile concern (packages/skills); the database stays the audit trail
 * (EventLog + ActivityLog), never the skill content store, so no migration
 * was required to ship this phase.
 */
import {
  AgentWorldProvider,
  GitHubProvider,
  LocalProvider,
  ProviderRegistry,
  SkillCatalog,
  SkillUsageTracker,
  SkillsShProvider,
  type ExternalSkillListing,
  type SkillRequest,
} from "../../../../packages/skills/src/index.js";

const BUILTIN_LISTINGS: ExternalSkillListing[] = [
  {
    externalId: "planning",
    name: "Planning",
    description: "Decomposes objectives into tasks, milestones, and acceptance criteria.",
    version: "1.0.0",
    author: "AgentWorld",
    category: "planning",
    source: { type: "AGENTWORLD", identifier: "planning", version: "1.0.0" },
  },
  {
    externalId: "research",
    name: "Research",
    description: "Gathers information from the world, memory, and documents.",
    version: "1.0.0",
    author: "AgentWorld",
    category: "research",
    source: { type: "AGENTWORLD", identifier: "research", version: "1.0.0" },
  },
  {
    externalId: "software",
    name: "Software",
    description: "Builds and modifies software artefacts.",
    version: "1.0.0",
    author: "AgentWorld",
    category: "coding",
    source: { type: "AGENTWORLD", identifier: "software", version: "1.0.0" },
  },
  {
    externalId: "testing",
    name: "Testing",
    description: "Designs and runs verification of produced work.",
    version: "1.0.0",
    author: "AgentWorld",
    category: "testing",
    source: { type: "AGENTWORLD", identifier: "testing", version: "1.0.0" },
  },
];

export const skillCatalog = new SkillCatalog();
export const skillUsage = new SkillUsageTracker();
export const skillRequests = new Map<string, SkillRequest>();
export const skillAssignments = new Map<string, Set<string>>();

export const skillProviders = new ProviderRegistry()
  .register(new AgentWorldProvider(BUILTIN_LISTINGS))
  .register(new SkillsShProvider())
  .register(new GitHubProvider())
  .register(new LocalProvider());

export function recordAssignment(skillKey: string, agentId: string): void {
  const set = skillAssignments.get(skillKey) ?? new Set<string>();
  set.add(agentId);
  skillAssignments.set(skillKey, set);
}

export function agentsForSkill(skillKey: string): string[] {
  return [...(skillAssignments.get(skillKey) ?? new Set<string>())];
}
