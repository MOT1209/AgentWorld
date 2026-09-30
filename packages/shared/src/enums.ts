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
  "PLANNED",
  "ASSIGNED",
  "RUNNING",
  "WAITING_APPROVAL",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

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

// -- Helpers -----------------------------------------------------------------

export function enumValues<T extends Record<string, string>>(obj: T): Array<T[keyof T]> {
  return Object.values(obj) as Array<T[keyof T]>;
}
