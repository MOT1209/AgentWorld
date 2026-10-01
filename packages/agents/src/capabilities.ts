/**
 * Agent capabilities.
 *
 * A capability is a declarative statement about what kind of work an agent can
 * accept. It is the missing link between "a task has type IMPLEMENTATION" and
 * "which agent should get it": the delegation engine asks
 * `agentCanHandleTaskType` instead of reading anyone's name.
 *
 * Rules:
 *
 *  - Capabilities are data. Adding one is a line in CAPABILITIES.
 *  - Unknown capability ids stored on an agent row are filtered, never fatal:
 *    an old row must not stop the world from booting.
 *  - The "general" capability matches every task type; without it an agent only
 *    receives work its declared capabilities cover.
 *  - Nothing here grants authority. Permissions decide what an agent MAY do;
 *    capabilities only decide what it is WILLING and equipped to do.
 */
import type { TaskType } from "../../shared/src/index.js";

export const CAPABILITY_IDS = [
  "planning",
  "research",
  "analysis",
  "software",
  "testing",
  "quality",
  "operations",
  "finance",
  "communication",
  "coordination",
  "general",
] as const;

export type Capability = (typeof CAPABILITY_IDS)[number];

export interface CapabilityDefinition {
  id: Capability;
  label: string;
  description: string;
  /** Task types this capability is qualified to accept. */
  taskTypes: readonly TaskType[];
}

export const CAPABILITIES: Record<Capability, CapabilityDefinition> = {
  planning: {
    id: "planning",
    label: "Planning",
    description: "Decomposes objectives into tasks, milestones, and acceptance criteria.",
    taskTypes: ["PLANNING", "COORDINATION"],
  },
  research: {
    id: "research",
    label: "Research",
    description: "Gathers information from the world, memory, and documents.",
    taskTypes: ["RESEARCH", "ANALYSIS"],
  },
  analysis: {
    id: "analysis",
    label: "Analysis",
    description: "Turns observations into findings, forecasts, and recommendations.",
    taskTypes: ["ANALYSIS", "RESEARCH"],
  },
  software: {
    id: "software",
    label: "Software",
    description: "Builds and modifies software artefacts.",
    taskTypes: ["IMPLEMENTATION", "TESTING"],
  },
  testing: {
    id: "testing",
    label: "Testing",
    description: "Designs and runs verification of produced work.",
    taskTypes: ["TESTING", "REVIEW"],
  },
  quality: {
    id: "quality",
    label: "Quality",
    description: "Reviews completed work against acceptance criteria.",
    taskTypes: ["REVIEW", "TESTING"],
  },
  operations: {
    id: "operations",
    label: "Operations",
    description: "Runs day-to-day company activity and tool-driven processes.",
    taskTypes: ["OPERATIONS", "COORDINATION"],
  },
  finance: {
    id: "finance",
    label: "Finance",
    description: "Handles money-related analysis and payments (still approval-gated).",
    taskTypes: ["OPERATIONS", "ANALYSIS"],
  },
  communication: {
    id: "communication",
    label: "Communication",
    description: "Produces messages, reports, and external correspondence.",
    taskTypes: ["COMMUNICATION", "COORDINATION"],
  },
  coordination: {
    id: "coordination",
    label: "Coordination",
    description: "Sequences work across agents and keeps plans on track.",
    taskTypes: ["COORDINATION", "PLANNING"],
  },
  general: {
    id: "general",
    label: "Generalist",
    description: "Accepts any task type. The fallback capability.",
    taskTypes: ["PLANNING", "RESEARCH", "ANALYSIS", "IMPLEMENTATION", "TESTING", "REVIEW", "OPERATIONS", "COORDINATION", "COMMUNICATION", "GENERAL"],
  },
};

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_IDS);

export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

/**
 * Clean a stored capability list: drop unknown ids, trim, dedupe, keep order.
 * Never throws -- an agent row with junk capabilities degrades, it does not
 * crash the registry.
 */
export function parseCapabilities(values: readonly string[]): Capability[] {
  const seen = new Set<Capability>();
  const out: Capability[] = [];
  for (const raw of values) {
    const id = raw.trim().toLowerCase();
    if (isCapability(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Can an agent with these capabilities accept a task of this type? */
export function agentCanHandleTaskType(
  capabilities: readonly string[],
  taskType: TaskType,
): boolean {
  const parsed = parseCapabilities(capabilities);
  if (parsed.length === 0) return false;
  return parsed.some((id) => CAPABILITIES[id].taskTypes.includes(taskType));
}

/** Which of the agent's capabilities qualify it for this task type? */
export function matchingCapabilities(
  capabilities: readonly string[],
  taskType: TaskType,
): Capability[] {
  return parseCapabilities(capabilities).filter((id) =>
    CAPABILITIES[id].taskTypes.includes(taskType),
  );
}

/** Capabilities that would qualify any agent for this task type. */
export function capabilitiesForTaskType(taskType: TaskType): Capability[] {
  return CAPABILITY_IDS.filter((id) => CAPABILITIES[id].taskTypes.includes(taskType));
}
