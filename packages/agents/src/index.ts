export {
  RoleProfileRegistry,
  roleProfiles,
  BUILT_IN_ROLES,
  type RoleProfile,
} from "./role-profiles.js";

export {
  createAgent,
  getAgent,
  findAgentBySlug,
  listAgents,
  updateAgent,
  changeAgentProvider,
  changeAgentState,
  getAgentState,
  getStateHistory,
  buildRuntimeProfile,
  toolsAllowedFor,
  listAgentsInCompany,
  countAgentsByState,
  type AgentContext,
  type CreateAgentInput,
  type UpdateAgentInput,
  type ChangeStateInput,
  type AgentRuntimeProfile,
} from "./agent.service.js";

export {
  createConversation,
  findOrCreateDirectConversation,
  sendMessage,
  resolveRecipient,
  parseRecipientSpec,
  listConversations,
  getConversationDetail,
  getUnreadCounts,
  markConversationRead,
  closeConversation,
  getRecentMessages,
  type RecipientSpec,
  type CommunicationContext,
  type CreateConversationInput,
  type SendMessageInput,
  type SendMessageResult,
  type ConversationDetail,
} from "./communication.service.js";

export {
  runAgent,
  type ToolInvoker,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunTrigger,
  type AgentRunOutcome,
  type RuntimeDeps,
} from "./runtime.js";

export {
  buildSystemPrompt,
  buildTurnMessages,
  MAX_CONTEXT_MESSAGES,
} from "./prompt-builder.js";

export {
  createBlueprint,
  listBlueprints,
  getBlueprint,
  instantiateBlueprint,
  setBlueprintStatus,
  type BlueprintContext,
  type CreateBlueprintInput,
} from "./blueprints.js";

export { syncHierarchyFromRoles, type HierarchySyncResult } from "./hierarchy-sync.js";

export {
  recordInteraction,
  listRelationships,
  getRelationship,
  closestPeers,
  type InteractionInput,
  type RelationshipContext,
} from "./relationships.js";

export {
  agentPerformance,
  agentsPerformance,
  companyPerformance,
  type AgentPerformanceSummary,
} from "./performance.js";

export {
  evolveReputation,
  evolveCompanyReputations,
  type ReputationResult,
  type EvolutionContext,
} from "./evolution.js";

export {
  startTrainingRun,
  evaluateTrainingRun,
  failTrainingRun,
  listTrainingRuns,
  type StartTrainingInput,
  type EvaluationInput,
  type AcademyContext,
} from "./academy.js";
