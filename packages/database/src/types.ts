/**
 * Prisma model and payload types, re-exported from one place.
 *
 * Domain packages import their persistence types from here rather than from
 * `@prisma/client` directly, so the generated-client surface they depend on is
 * visible in a single file and can be insulated later if the ORM changes.
 */
export type {
  User,
  Company,
  Department,
  CompanyMember,
  World,
  City,
  District,
  Location,
  Agent,
  AgentState,
  AgentStateHistory,
  AgentActivity,
  AgentRoutine,
  AgentGoal,
  AgentMemory,
  AgentRelationship,
  Project,
  Task,
  TaskDependency,
  Conversation,
  ConversationParticipant,
  Message,
  Wallet,
  Transaction,
  ApprovalRequest,
  AgentBlueprint,
  EventLog,
  ActivityLog,
  ToolInvocation,
  // Phase 2 orchestration.
  Plan,
  TaskReview,
  Report,
  AgentSession,
  AgentHierarchy,
  Escalation,
  DecisionConflict,
  // Phase 3 workspaces.
  Workspace,
  WorkspaceMember,
  // Phase 3 execution.
  ExecutionJob,
  Artifact,
  // Phase 4 integrations.
  Credential,
  AiUsage,
  WebhookSubscription,
  WebhookDelivery,
  ApiKey,
  TestRun,
  FactoryRun,
  // Phase 6 academy.
  TrainingRun,
} from "@prisma/client";

/** ActorRef lives in shared so no domain package needs the ORM to name a caller. */
export type { ActorRef } from "../../shared/src/actor.js";
export { SYSTEM_ACTOR, actorUser, actorAgent, actorSystem } from "../../shared/src/actor.js";

