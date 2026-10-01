import { z } from "zod";

/**
 * Single source of truth for every enum-like value persisted as a `String`
 * column (the SQLite connector has no native enum type).
 *
 * Rule for the whole codebase: never write a raw string literal for one of
 * these. Import the schema and parse it, so a typo becomes a validation error
 * at the boundary instead of corrupt data in the database.
 */

// -- Users & access -----------------------------------------------------------

export const UserRole = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  OBSERVER: "OBSERVER",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const UserRoleSchema = z.nativeEnum(UserRole);

// -- Agent lifecycle ---------------------------------------------------------

export const AgentState = {
  ONLINE: "ONLINE",
  OFFLINE: "OFFLINE",
  IDLE: "IDLE",
  WORKING: "WORKING",
  THINKING: "THINKING",
  WAITING: "WAITING",
  SLEEPING: "SLEEPING",
  // Phase 1 simulation states (additive: the column is a String).
  TRAVELING: "TRAVELING",
  RESTING: "RESTING",
  SOCIALIZING: "SOCIALIZING",
  ERROR: "ERROR",
  PAUSED: "PAUSED",
} as const;
export type AgentState = (typeof AgentState)[keyof typeof AgentState];
export const AgentStateSchema = z.nativeEnum(AgentState);

export const MEMORY_KINDS = ["SHORT_TERM", "LONG_TERM", "EPISODIC", "FACT"] as const;
export const MemoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MEMORY_SOURCES = [
  "CONVERSATION",
  "TASK",
  "EVENT",
  "TOOL",
  "OBSERVATION",
  "HUMAN",
  "SYSTEM",
] as const;
export const MemorySourceSchema = z.enum(MEMORY_SOURCES);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

// -- Tasks -------------------------------------------------------------------

export const TASK_STATUSES = [
  "PENDING",
  "PLANNING",
  "READY",
  "PLANNED",
  "ASSIGNED",
  "RUNNING",
  "WAITING_APPROVAL",
  "BLOCKED",
  "REVIEWING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Ordering only -- never compare these strings directly. MEDIUM is the Phase 1
 * name for "normal"; both rank identically so old rows keep working.
 */
export const TASK_PRIORITY_RANK: Record<TaskPriority, number> = {
  LOW: 0,
  MEDIUM: 1,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
  CRITICAL: 4,
};

export const TASK_PRIORITIES = [
  "LOW",
  "MEDIUM",
  "NORMAL",
  "HIGH",
  "URGENT",
  "CRITICAL",
] as const;
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/** Higher wins. Ties fall back to creation order (handled by the caller). */
export function priorityRank(priority: string): number {
  return TASK_PRIORITY_RANK[priority as TaskPriority] ?? 1;
}

/** Phase 2 task types. Matched against an agent's capabilities when delegating. */
export const TASK_TYPES = [
  "PLANNING",
  "RESEARCH",
  "ANALYSIS",
  "IMPLEMENTATION",
  "TESTING",
  "REVIEW",
  "OPERATIONS",
  "COORDINATION",
  "COMMUNICATION",
  "GENERAL",
] as const;
export const TaskTypeSchema = z.enum(TASK_TYPES);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const PROJECT_STATUSES = [
  "PLANNING",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);

// -- Communication -----------------------------------------------------------

export const CONVERSATION_KINDS = ["HUMAN_AGENT", "AGENT_AGENT", "SYSTEM"] as const;
export const ConversationKindSchema = z.enum(CONVERSATION_KINDS);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const SENDER_TYPES = ["HUMAN", "AGENT", "SYSTEM"] as const;
export const SenderTypeSchema = z.enum(SENDER_TYPES);
export type SenderType = z.infer<typeof SenderTypeSchema>;

export const MESSAGE_KINDS = [
  "MESSAGE",
  "PLAN",
  "REPORT",
  "REQUEST",
  "QUESTION",
  "APPROVAL_REQUEST",
  "APPROVAL_RESPONSE",
  "TASK",
  "TASK_UPDATE",
  "WARNING",
  "ERROR",
  "SYSTEM",
  "TOOL_RESULT",
  "TASK_RESULT",
  "SYSTEM_NOTICE",
] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKindSchema>;

// -- Economy -----------------------------------------------------------------

export const TRANSACTION_TYPES = [
  "DEPOSIT",
  "WITHDRAWAL",
  "TRANSFER",
  "SALARY",
  "PURCHASE",
  "REWARD",
  "PENALTY",
  "TAX",
  "FEE",
  "ADJUSTMENT",
] as const;
export const TransactionTypeSchema = z.enum(TRANSACTION_TYPES);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

export const LEDGER_DIRECTIONS = ["DEBIT", "CREDIT"] as const;
export const LedgerDirectionSchema = z.enum(LEDGER_DIRECTIONS);
export type LedgerDirection = z.infer<typeof LedgerDirectionSchema>;

export const WALLET_OWNER_TYPES = ["AGENT", "USER", "COMPANY"] as const;
export const WalletOwnerTypeSchema = z.enum(WALLET_OWNER_TYPES);
export type WalletOwnerType = z.infer<typeof WalletOwnerTypeSchema>;

export const DEFAULT_CURRENCY = "KW";

// -- World -------------------------------------------------------------------

export const LOCATION_KINDS = [
  "HQ",
  "BANK",
  "MARKET",
  "OFFICE",
  "HOME",
  "SHOP",
  "RESTAURANT",
  "SCHOOL",
  "HOSPITAL",
  "GOVERNMENT",
  "TRANSPORT",
  "PUBLIC_SPACE",
  "OTHER",
] as const;
export const LocationKindSchema = z.enum(LOCATION_KINDS);
export type LocationKind = z.infer<typeof LocationKindSchema>;

// -- Approvals ---------------------------------------------------------------

export const APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const BLUEPRINT_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "INSTANTIATED",
] as const;
export const BlueprintStatusSchema = z.enum(BLUEPRINT_STATUSES);
export type BlueprintStatus = z.infer<typeof BlueprintStatusSchema>;

// -- Phase 2 orchestration ---------------------------------------------------

export const PLAN_STATUSES = [
  "DRAFT",
  "ANALYZING",
  "READY",
  "EXECUTING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export const PlanStatusSchema = z.enum(PLAN_STATUSES);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PLAN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  DRAFT: ["ANALYZING", "CANCELLED"],
  ANALYZING: ["READY", "DRAFT", "CANCELLED"],
  READY: ["EXECUTING", "PAUSED", "CANCELLED"],
  EXECUTING: ["PAUSED", "COMPLETED", "FAILED", "CANCELLED"],
  PAUSED: ["EXECUTING", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["READY", "CANCELLED"],
  CANCELLED: [],
};

export const SESSION_STATUSES = [
  "INITIALIZING",
  "RUNNING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const REVIEW_OUTCOMES = [
  "APPROVED",
  "NEEDS_CHANGES",
  "REJECTED",
  "ESCALATE",
] as const;
export const ReviewOutcomeSchema = z.enum(REVIEW_OUTCOMES);
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

export const REPORT_KINDS = [
  "PROGRESS",
  "TASK",
  "EXECUTION",
  "REVIEW",
  "ERROR",
] as const;
export const ReportKindSchema = z.enum(REPORT_KINDS);
export type ReportKind = z.infer<typeof ReportKindSchema>;

export const ESCALATION_CATEGORIES = [
  "BLOCKED",
  "TOOL_UNAVAILABLE",
  "TASK_IMPOSSIBLE",
  "APPROVAL_REQUIRED",
  "REPEATED_FAILURE",
  "PERMISSION_DENIED",
  "MISSING_INFORMATION",
] as const;
export const EscalationCategorySchema = z.enum(ESCALATION_CATEGORIES);
export type EscalationCategory = z.infer<typeof EscalationCategorySchema>;

export const ESCALATION_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "REJECTED",
] as const;
export const EscalationStatusSchema = z.enum(ESCALATION_STATUSES);
export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;

export const CONFLICT_STATUSES = [
  "OPEN",
  "DISCUSSING",
  "RESOLVED",
  "ESCALATED",
] as const;
export const ConflictStatusSchema = z.enum(CONFLICT_STATUSES);
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;

export const HIERARCHY_KINDS = ["STRATEGIC", "OPERATIONAL"] as const;
export const HierarchyKindSchema = z.enum(HIERARCHY_KINDS);
export type HierarchyKind = z.infer<typeof HierarchyKindSchema>;

/** How many tasks an agent may hold at once. Mirrors Agent.concurrency. */
export const CONCURRENCY_LEVELS = ["LOW", "NORMAL", "HIGH"] as const;
export const ConcurrencyLevelSchema = z.enum(CONCURRENCY_LEVELS);
export type ConcurrencyLevel = z.infer<typeof ConcurrencyLevelSchema>;

export const ERROR_CATEGORIES = [
  "TRANSIENT",
  "CONFIGURATION",
  "PERMISSION",
  "INPUT",
  "TOOL",
  "AI_PROVIDER",
  "SYSTEM",
  "UNKNOWN",
] as const;
export const ErrorCategorySchema = z.enum(ERROR_CATEGORIES);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

// -- Observability -----------------------------------------------------------

export const SEVERITIES = ["INFO", "WARN", "ERROR", "CRITICAL"] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

export const ACTOR_TYPES = ["USER", "AGENT", "SYSTEM"] as const;
export const ActorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const TOOL_INVOCATION_STATUSES = [
  "SUCCESS",
  "DENIED",
  "PENDING_APPROVAL",
  "ERROR",
] as const;
export const ToolInvocationStatusSchema = z.enum(TOOL_INVOCATION_STATUSES);
export type ToolInvocationStatus = z.infer<typeof ToolInvocationStatusSchema>;

export const OPERATION_RESULTS = ["OK", "ERROR"] as const;
export const OperationResultSchema = z.enum(OPERATION_RESULTS);

// -- Simulation (Phase 1 core engine) ----------------------------------------

/**
 * Lifecycle of a World. The engine only ticks a RUNNING world; PAUSED keeps
 * every agent, activity and need frozen without losing state.
 */
export const WORLD_STATUSES = [
  "INITIALIZING",
  "RUNNING",
  "PAUSED",
  "STOPPED",
  "ERROR",
] as const;
export const WorldStatusSchema = z.enum(WORLD_STATUSES);
export type WorldStatus = z.infer<typeof WorldStatusSchema>;

/** Development-facing speed presets. Internally any 0.1x..10000x is allowed. */
export const SPEED_PRESETS = [0.5, 1, 2, 10, 60] as const;
export type SpeedPreset = (typeof SPEED_PRESETS)[number];

/** What an agent is occupationally doing over an interval. */
export const ACTIVITY_TYPES = [
  "WORK",
  "REST",
  "THINK",
  "TRAVEL",
  "SOCIALIZE",
  "IDLE",
  "SLEEP",
] as const;
export const ActivityTypeSchema = z.enum(ACTIVITY_TYPES);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;

export const ACTIVITY_STATUSES = [
  "PLANNED",
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;
export const ActivityStatusSchema = z.enum(ACTIVITY_STATUSES);
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

/** Only one activity per agent may be PLANNED or ACTIVE at a time. */
export const OPEN_ACTIVITY_STATUSES: readonly ActivityStatus[] = ["PLANNED", "ACTIVE"];

export const GOAL_STATUSES = [
  "PENDING",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export const GoalStatusSchema = z.enum(GOAL_STATUSES);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

/** Simulated needs (Phase 1 spec section 12). 0..100, never a real biology. */
export const NEED_TYPES = [
  "ENERGY",
  "HUNGER",
  "SOCIAL",
  "REST",
  "ENTERTAINMENT",
] as const;
export const NeedTypeSchema = z.enum(NEED_TYPES);
export type NeedType = z.infer<typeof NeedTypeSchema>;

/** Simulation-level actions. Distinct from the AI tool surface. */
export const AGENT_ACTION_TYPES = [
  "MOVE",
  "START_ACTIVITY",
  "STOP_ACTIVITY",
  "REST",
  "IDLE",
] as const;
export const AgentActionTypeSchema = z.enum(AGENT_ACTION_TYPES);
export type AgentActionType = z.infer<typeof AgentActionTypeSchema>;

/**
 * Validated agent lifecycle transitions (Phase 1 spec section 21).
 *
 * OFFLINE -> IDLE/ONLINE is how an agent comes back. ERROR may only be left
 * through an explicit recovery into IDLE or ONLINE, so a failing agent cannot
 * silently resume work. The simulation engine and the ActionValidator both
 * consult this table before any state write.
 */
export const AGENT_STATE_TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  OFFLINE: ["ONLINE", "IDLE", "ERROR"],
  ONLINE: ["IDLE", "OFFLINE", "WORKING", "THINKING", "SLEEPING", "TRAVELING", "RESTING", "SOCIALIZING", "PAUSED", "ERROR"],
  IDLE: ["WORKING", "THINKING", "WAITING", "SLEEPING", "TRAVELING", "RESTING", "SOCIALIZING", "ONLINE", "OFFLINE", "PAUSED", "ERROR"],
  WORKING: ["IDLE", "WAITING", "THINKING", "PAUSED", "OFFLINE", "ERROR"],
  THINKING: ["IDLE", "WORKING", "WAITING", "PAUSED", "OFFLINE", "ERROR"],
  WAITING: ["IDLE", "WORKING", "THINKING", "PAUSED", "OFFLINE", "ERROR"],
  SLEEPING: ["IDLE", "ONLINE", "OFFLINE", "PAUSED", "ERROR"],
  TRAVELING: ["IDLE", "WORKING", "SOCIALIZING", "PAUSED", "OFFLINE", "ERROR"],
  RESTING: ["IDLE", "SLEEPING", "WORKING", "PAUSED", "OFFLINE", "ERROR"],
  SOCIALIZING: ["IDLE", "WORKING", "RESTING", "PAUSED", "OFFLINE", "ERROR"],
  PAUSED: ["IDLE", "ONLINE", "OFFLINE", "ERROR"],
  ERROR: ["IDLE", "ONLINE"],
};

export function canTransitionAgentState(from: AgentState, to: AgentState): boolean {
  if (from === to) return true;
  return (AGENT_STATE_TRANSITIONS[from] ?? []).includes(to);
}

// -- Helpers -----------------------------------------------------------------

export function enumValues<T extends Record<string, string>>(obj: T): Array<T[keyof T]> {
  return Object.values(obj) as Array<T[keyof T]>;
}
