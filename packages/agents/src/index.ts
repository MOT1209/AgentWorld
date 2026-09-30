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
