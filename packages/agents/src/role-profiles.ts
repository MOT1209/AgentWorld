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
      "Break goals into small, independently verifiable tasks. Give each one a clear title, a description that states what 'done' means, and a priority.",
      "When you have produced work items, hand them to the appropriate executor using message.send, and explain what you expect back.",
    ],
    behaviouralRules: [
      "Never claim work is done unless a task result or a report message confirms it.",
      "Always create tasks before delegating; do not delegate work that does not exist as a task.",
      "Prioritise explicitly. If everything is high priority, nothing is.",
      "Do not move money. Escalate anything that needs spending to a human.",
    ],
    permissions: [
      ...COMMON_PERMISSIONS,
      PERMISSIONS.TASK_CREATE,
      PERMISSIONS.TASK_UPDATE,
      PERMISSIONS.TASK_ASSIGN,
      PERMISSIONS.TASK_COMPLETE,
      PERMISSIONS.TASK_CANCEL,
      PERMISSIONS.MESSAGE_SEND,
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
    ],
    maxIterations: 8,
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
    ],
    behaviouralRules: [
      "Report the real outcome. If a step failed, say so and record the error rather than describing success.",
      "Never perform a privileged, irreversible, or expensive action without an approved human decision. If an action needs approval, request it and stop.",
      "Do not create other agents. Escalate that request to a human.",
      "Keep spending within the amounts you have been given. Never assume additional budget.",
    ],
    permissions: [
      ...COMMON_PERMISSIONS,
      PERMISSIONS.TASK_CREATE,
      PERMISSIONS.TASK_UPDATE,
      PERMISSIONS.TASK_COMPLETE,
      PERMISSIONS.MESSAGE_SEND,
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
    ],
    maxIterations: 10,
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
    permissions: [...COMMON_PERMISSIONS, PERMISSIONS.TASK_UPDATE, PERMISSIONS.MESSAGE_SEND],
    allowedTools: [
      "task.list",
      "task.update",
      "message.send",
      "memory.store",
      "memory.search",
      "world.get_state",
      "company.info",
    ],
    maxIterations: 6,
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
    permissions: [...COMMON_PERMISSIONS, PERMISSIONS.TASK_CREATE, PERMISSIONS.MESSAGE_SEND],
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
    ],
    maxIterations: 6,
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

  return profile;
}

export class RoleProfileRegistry {
  private readonly profiles = new Map<string, RoleProfile>();

  constructor(profiles: RoleProfile[] = BUILT_IN_ROLES) {
    for (const profile of profiles) this.register(profile);
  }

  register(profile: RoleProfile): this {
    this.profiles.set(profile.roleKey, validateProfile(profile));
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

  /** True when the role may invoke the tool, ignoring permissions. */
  roleAllowsTool(roleKey: string, toolName: string): boolean {
    const profile = this.get(roleKey);
    if (profile.allowedTools === "*") return true;
    return profile.allowedTools.includes(toolName);
  }
}

export const roleProfiles = new RoleProfileRegistry();
export { BUILT_IN_ROLES };
