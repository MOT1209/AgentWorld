/**
 * Role profiles.
 *
 * This is the answer to "how do I make Ahmad behave differently from Rashid
 * without special-casing either of them". A role is DATA: a system prompt
 * fragment set, a permission grant, and a tool allow-list. Two agents with the
 * same roleKey behave identically regardless of their names; two agents with
 * different roleKeys behave differently even if identically named.
 *
 * Adding a role is a one-line change here. Nothing else in the codebase reads
 * an agent's name to decide what it may do.
 *
 * Two invariants are enforced at registration time rather than by convention:
 *
 *  - No role may grant a HUMAN_ONLY permission. An agent that could approve
 *    its own spend or widen its own authority would defeat the entire approval
 *    system, so the registry refuses to load such a role.
 *  - Every role's tool allow-list entries are dotted names matching the tool
 *    naming convention, so a typo fails loudly at boot.
 */
import { validationError } from "../../shared/src/index.js";
import {
  assertNoHumanOnlyPermissions,
  isPermission,
  PERMISSIONS,
  type Permission,
} from "../../security/src/permissions.js";
import { isValidToolName } from "../../shared/src/index.js";
import { isCapability, type Capability } from "./capabilities.js";
import { assertAcyclic, buildGraph, type HierarchyNode } from "./hierarchy.js";

export interface RoleProfile {
  roleKey: string;
  displayName: string;
  description: string;
  /** Appended to the agent's own systemPrompt. */
  systemPromptFragments: string[];
  /** Hard rules restated on every turn; models follow explicit prohibitions. */
  behaviouralRules: string[];
  permissions: Permission[];
  /** Dotted tool names, or "*" for every tool the permissions allow. */
  allowedTools: string[] | "*";
  maxIterations: number;
  /** Overrides the agent's configured temperature when set. */
  temperature?: number;
  /**
   * What this role is equipped to do. Used by the delegation engine to match
   * a task's type to a willing agent; carries no authority by itself.
   * Absent means the role never matches task-type delegation.
   */
  capabilities?: Capability[];
  /**
   * Role that receives this role's escalations. Absent means the role is a
   * root and escalates directly to a human. Never a name -- always a roleKey.
   */
  reportsTo?: string;
}

const READ_CONTEXT_PERMISSIONS: Permission[] = [
  PERMISSIONS.TASK_READ,
  PERMISSIONS.MESSAGE_READ,
  PERMISSIONS.MEMORY_READ,
  PERMISSIONS.WORLD_READ,
  PERMISSIONS.COMPANY_READ,
  PERMISSIONS.WALLET_READ,
  PERMISSIONS.AGENT_READ,
  PERMISSIONS.EVENT_READ,
];

const COMMON_PERMISSIONS: Permission[] = [
  ...READ_CONTEXT_PERMISSIONS,
  PERMISSIONS.MEMORY_WRITE,
  PERMISSIONS.EVENT_EMIT,
];

const BUILT_IN_ROLES: RoleProfile[] = [
  {
    roleKey: "PLANNER",
    displayName: "Planning & Strategy Agent",
    description:
      "Understands objectives, decomposes them into work, delegates to executors, and reviews results.",
    systemPromptFragments: [
      "You are a planning and strategy agent.",
      "Your cycle is UNDERSTAND -> ANALYSE -> PLAN -> DELEGATE -> REVIEW.",
      "You do not execute work yourself. You convert an objective into concrete tasks, assign them to the right agent, and then verify the outcome.",
      "Break goals into small, independently verifiable tasks. Give each one a clear title, a description that states what 'done' is, and a priority.",
      "Start by creating a plan that records milestones, assumptions, and risks, then decompose it into tasks that reference the plan.",
      "When you have produced work items, hand them to the appropriate executor using message.send, and explain what you expect back.",
      "Review returned work against the task's acceptance criteria. Approve, request changes, or escalate -- never rubber-stamp.",
    ],
    behaviouralRules: [
      "Never claim work is done unless a task result or a report message confirms it.",
      "Always create tasks before delegating; do not delegate work that does not exist as a task.",
      "Prioritise explicitly. If everything is high priority, nothing is.",
      "Do not move money. Escalate anything that needs spending to a human.",
      "Plan approval belongs to a human; you propose plans, you do not sign them off.",
    ],
    permissions: [
      ...COMMON_PERMISSIONS,
      PERMISSIONS.TASK_CREATE,
      PERMISSIONS.TASK_UPDATE,
      PERMISSIONS.TASK_ASSIGN,
      PERMISSIONS.TASK_COMPLETE,
      PERMISSIONS.TASK_CANCEL,
      PERMISSIONS.TASK_REVIEW,
      PERMISSIONS.MESSAGE_SEND,
      PERMISSIONS.PLAN_READ,
      PERMISSIONS.PLAN_CREATE,
      PERMISSIONS.PLAN_UPDATE,
      PERMISSIONS.REPORT_CREATE,
      PERMISSIONS.ESCALATE,
      PERMISSIONS.SESSION_READ,
      PERMISSIONS.WORKSPACE_READ,
    ],
    allowedTools: [
      "task.create",
      "task.update",
      "task.list",
      "message.send",
      "memory.store",
      "memory.search",
      "world.get_state",
      "world.get_location",
      "company.info",
      "wallet.balance",
      "event.emit",
      "plan.create",
      "plan.update",
      "plan.list",
      "plan.get",
      "review.submit",
      "report.submit",
      "agent.escalate",
      "workspace.list",
      "workspace.get",
    ],
    maxIterations: 8,
    capabilities: ["planning", "coordination", "research", "analysis"],
    // Root of the hierarchy: escalations leave the agent graph here and go to a human.
  },
  {
    roleKey: "EXECUTOR",
    displayName: "Executive / Operations Agent",
    description:
      "Carries out assigned work, operates the company, uses tools within its permissions, reports results, and escalates anything risky.",
    systemPromptFragments: [
      "You are an executive and operations agent.",
      "You carry out work that has been assigned to you and you report the outcome honestly.",
      "For each assigned task: start it, do the work, record the result, complete it, then report back to whoever delegated it.",
      "You manage operational activity, track company resources, and detect failures.",
      "If a task is blocked, impossible, or needs a decision you cannot make, escalate it with a precise description instead of guessing or silently failing.",
    ],
    behaviouralRules: [
      "Report the real outcome. If a step failed, say so and record the error rather than describing success.",
      "Never perform a privileged, irreversible, or expensive action without an approved human decision. If an action needs approval, request it and stop.",
      "Do not create other agents. Escalate that request to a human.",
      "Keep spending within the amounts you have been given. Never assume additional budget.",
      "After the configured number of failed attempts on the same task, stop and escalate rather than retrying.",
    ],
    permissions: [
      ...COMMON_PERMISSIONS,
      PERMISSIONS.TASK_CREATE,
      PERMISSIONS.TASK_UPDATE,
      PERMISSIONS.TASK_COMPLETE,
      PERMISSIONS.MESSAGE_SEND,
      PERMISSIONS.PLAN_READ,
      PERMISSIONS.REPORT_CREATE,
      PERMISSIONS.ESCALATE,
      PERMISSIONS.SESSION_READ,
      PERMISSIONS.SESSION_START,
      PERMISSIONS.WORKSPACE_READ,
      PERMISSIONS.WORKSPACE_WRITE,
      // Transfers are permitted but policy-gated: small routine payments run,
      // anything at or above the configured threshold requires human approval.
      PERMISSIONS.WALLET_TRANSFER,
      PERMISSIONS.APPROVAL_REQUEST,
    ],
    allowedTools: [
      "task.create",
      "task.update",
      "task.list",
      "message.send",
      "memory.store",
      "memory.search",
      "world.get_state",
      "world.get_location",
      "company.info",
      "wallet.balance",
      "wallet.transfer",
      "event.emit",
      "plan.list",
      "plan.get",
      "report.submit",
      "agent.escalate",
      "session.start",
      "session.status",
      "workspace.create",
      "workspace.list",
      "workspace.get",
      "workspace.status",
      "workspace.share",
    ],
    maxIterations: 10,
    capabilities: ["operations", "finance", "communication", "research", "general"],
    reportsTo: "PLANNER",
  },
  {
    roleKey: "REVIEWER",
    displayName: "Review & Quality Agent",
    description: "Audits completed work against its acceptance criteria and raises defects.",
    systemPromptFragments: [
      "You review completed work. You do not execute it.",
      "Compare the recorded result against the task's stated intent and report whether it actually satisfies it.",
    ],
    behaviouralRules: [
      "Be specific about what is wrong. 'Incomplete' is not a review.",
      "Never mark your own work as reviewed.",
    ],
    permissions: [
      ...COMMON_PERMISSIONS,
      PERMISSIONS.TASK_UPDATE,
      PERMISSIONS.TASK_REVIEW,
      PERMISSIONS.MESSAGE_SEND,
      PERMISSIONS.PLAN_READ,
      PERMISSIONS.REPORT_CREATE,
      PERMISSIONS.ESCALATE,
    ],
    allowedTools: [
      "task.list",
      "task.update",
      "message.send",
      "memory.store",
      "memory.search",
      "world.get_state",
      "company.info",
      "plan.list",
      "plan.get",
      "review.submit",
      "report.submit",
      "agent.escalate",
    ],
    maxIterations: 6,
    capabilities: ["quality", "testing"],
    reportsTo: "PLANNER",
  },
  {
    roleKey: "ANALYST",
    displayName: "Analysis Agent",
    description: "Investigates questions, produces findings, and stores them for later recall.",
    systemPromptFragments: [
      "You analyse. You gather context, draw conclusions, and record findings as durable facts.",
      "You do not change company structure and you do not move money.",
    ],
    behaviouralRules: [
      "Distinguish what you observed from what you inferred.",
      "Store conclusions as facts with enough context to be useful later.",
    ],
    permissions: [
      ...COMMON_PERMISSIONS,
      PERMISSIONS.TASK_CREATE,
      PERMISSIONS.MESSAGE_SEND,
      PERMISSIONS.PLAN_READ,
      PERMISSIONS.REPORT_CREATE,
      PERMISSIONS.ESCALATE,
    ],
    allowedTools: [
      "task.create",
      "task.list",
      "message.send",
      "memory.store",
      "memory.search",
      "world.get_state",
      "world.get_location",
      "company.info",
      "wallet.balance",
      "plan.list",
      "plan.get",
      "report.submit",
      "agent.escalate",
    ],
    maxIterations: 6,
    capabilities: ["analysis", "research"],
    reportsTo: "PLANNER",
  },
];

function validateProfile(profile: RoleProfile): RoleProfile {
  const unknown = profile.permissions.filter((permission) => !isPermission(permission));
  if (unknown.length > 0) {
    throw validationError(`Role '${profile.roleKey}' grants unknown permissions: ${unknown.join(", ")}`);
  }

  // The critical guard: an agent may never be able to approve itself.
  assertNoHumanOnlyPermissions(profile.permissions, `Role '${profile.roleKey}'`);

  if (profile.allowedTools !== "*") {
    const invalid = profile.allowedTools.filter((tool) => !isValidToolName(tool));
    if (invalid.length > 0) {
      throw validationError(
        `Role '${profile.roleKey}' lists malformed tool names: ${invalid.join(", ")}`,
      );
    }
  }

  if (profile.maxIterations < 1 || profile.maxIterations > 50) {
    throw validationError(`Role '${profile.roleKey}' has an out-of-range maxIterations`);
  }

  const unknownCapabilities = (profile.capabilities ?? []).filter((c) => !isCapability(c));
  if (unknownCapabilities.length > 0) {
    throw validationError(
      `Role '${profile.roleKey}' declares unknown capabilities: ${unknownCapabilities.join(", ")}`,
    );
  }

  return profile;
}

/**
 * Structural checks across the whole registered set: `reportsTo` targets must
 * exist, and the escalation graph must be acyclic. Runs against the
 * *candidate* set before it is committed, so a rejected registration leaves
 * the registry exactly as it was.
 */
function validateHierarchy(profiles: Iterable<RoleProfile>): void {
  const nodes: HierarchyNode[] = [];
  const keys = new Set<string>();
  for (const profile of profiles) keys.add(profile.roleKey);

  for (const profile of profiles) {
    if (profile.reportsTo !== undefined && !keys.has(profile.reportsTo)) {
      throw validationError(
        `Role '${profile.roleKey}' reports to unknown role '${profile.reportsTo}'`,
      );
    }
    nodes.push({
      roleKey: profile.roleKey,
      reportsTo: profile.reportsTo,
      capabilities: profile.capabilities ?? [],
    });
  }
  assertAcyclic(buildGraph(nodes));
}

export class RoleProfileRegistry {
  private profiles = new Map<string, RoleProfile>();

  constructor(profiles: RoleProfile[] = BUILT_IN_ROLES) {
    const candidate = new Map<string, RoleProfile>();
    for (const profile of profiles) {
      candidate.set(profile.roleKey, validateProfile(profile));
    }
    validateHierarchy(candidate.values());
    this.profiles = candidate;
  }

  register(profile: RoleProfile): this {
    const validated = validateProfile(profile);
    const candidate = new Map(this.profiles);
    candidate.set(profile.roleKey, validated);
    validateHierarchy(candidate.values());
    this.profiles = candidate;
    return this;
  }

  has(roleKey: string): boolean {
    return this.profiles.has(roleKey);
  }

  get(roleKey: string): RoleProfile {
    const profile = this.profiles.get(roleKey);
    if (profile === undefined) {
      const known = [...this.profiles.keys()].join(", ");
      throw validationError(`Unknown agent role '${roleKey}'. Registered roles: ${known}`);
    }
    return profile;
  }

  list(): RoleProfile[] {
    return [...this.profiles.values()];
  }

  /** RoleKey this role escalates to, or undefined when it goes to a human. */
  escalationTarget(roleKey: string): string | undefined {
    return this.get(roleKey).reportsTo;
  }

  /** Snapshot of the hierarchy graph for the pure walkers in hierarchy.ts. */
  hierarchyGraph(): ReadonlyMap<string, HierarchyNode> {
    return buildGraph(
      this.list().map((profile) => ({
        roleKey: profile.roleKey,
        reportsTo: profile.reportsTo,
        capabilities: profile.capabilities ?? [],
      })),
    );
  }

  /** True when the role may invoke the tool, ignoring permissions. */
  roleAllowsTool(roleKey: string, toolName: string): boolean {
    const profile = this.get(roleKey);
    if (profile.allowedTools === "*") return true;
    return profile.allowedTools.includes(toolName);
  }
}

export const roleProfiles = new RoleProfileRegistry();
export { BUILT_IN_ROLES };
