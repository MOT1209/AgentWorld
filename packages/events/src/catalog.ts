/**
 * Domain event catalogue.
 *
 * Events are the spine of the simulation: Phase 2's city, relationships and
 * daily routine will all be driven by reacting to this stream rather than by
 * polling state. The catalogue is therefore declared as data, with a payload
 * type per event, so an emitter and a subscriber cannot drift apart.
 *
 * Naming: <SUBJECT>_<PAST_TENSE_VERB>. Events are facts ("this happened"), not
 * commands. Nothing may subscribe in order to *cause* an event; that is what
 * services are for.
 */

export const EVENT_TYPES = {
  // World
  WORLD_CREATED: "WORLD_CREATED",
  WORLD_TICK: "WORLD_TICK",
  LOCATION_CHANGED: "LOCATION_CHANGED",

  // Company
  COMPANY_CREATED: "COMPANY_CREATED",
  COMPANY_STRUCTURE_MODIFIED: "COMPANY_STRUCTURE_MODIFIED",
  DEPARTMENT_CREATED: "DEPARTMENT_CREATED",

  // Agents
  AGENT_CREATED: "AGENT_CREATED",
  AGENT_STATE_CHANGED: "AGENT_STATE_CHANGED",
  AGENT_MEMORY_STORED: "AGENT_MEMORY_STORED",
  AGENT_BLUEPRINT_REQUESTED: "AGENT_BLUEPRINT_REQUESTED",
  AGENT_RUN_STARTED: "AGENT_RUN_STARTED",
  AGENT_RUN_FINISHED: "AGENT_RUN_FINISHED",

  // Communication
  CONVERSATION_CREATED: "CONVERSATION_CREATED",
  MESSAGE_SENT: "MESSAGE_SENT",

  // Tasks
  TASK_CREATED: "TASK_CREATED",
  TASK_ASSIGNED: "TASK_ASSIGNED",
  TASK_STARTED: "TASK_STARTED",
  TASK_COMPLETED: "TASK_COMPLETED",
  TASK_FAILED: "TASK_FAILED",
  TASK_STATUS_CHANGED: "TASK_STATUS_CHANGED",
  TASK_CANCELLED: "TASK_CANCELLED",

  // Economy
  MONEY_TRANSFERRED: "MONEY_TRANSFERRED",
  MONEY_DEPOSITED: "MONEY_DEPOSITED",
  MONEY_WITHDRAWN: "MONEY_WITHDRAWN",
  SALARY_PAID: "SALARY_PAID",
  PURCHASE_MADE: "PURCHASE_MADE",
  TRANSACTION_RECORDED: "TRANSACTION_RECORDED",

  // Approvals
  APPROVAL_REQUESTED: "APPROVAL_REQUESTED",
  APPROVAL_GRANTED: "APPROVAL_GRANTED",
  APPROVAL_REJECTED: "APPROVAL_REJECTED",
  APPROVAL_EXPIRED: "APPROVAL_EXPIRED",

  // Planning & orchestration (Phase 2)
  PLAN_CREATED: "PLAN_CREATED",
  PLAN_STATUS_CHANGED: "PLAN_STATUS_CHANGED",
  PLAN_APPROVED: "PLAN_APPROVED",
  TASK_REVIEWED: "TASK_REVIEWED",
  REPORT_WRITTEN: "REPORT_WRITTEN",
  ESCALATION_RAISED: "ESCALATION_RAISED",
  ESCALATION_RESOLVED: "ESCALATION_RESOLVED",
  DECISION_CONFLICT_RAISED: "DECISION_CONFLICT_RAISED",
  DECISION_CONFLICT_RESOLVED: "DECISION_CONFLICT_RESOLVED",
  SESSION_STARTED: "SESSION_STARTED",
  SESSION_FINISHED: "SESSION_FINISHED",

  // Tools
  TOOL_INVOKED: "TOOL_INVOKED",
  TOOL_DENIED: "TOOL_DENIED",

  // Agent-authored observations. Separate from system events so an operator can
  // always tell an agent's own account of something from the system's.
  AGENT_OBSERVATION: "AGENT_OBSERVATION",

  // Simulation (Phase 1 core engine). World status is deliberately one event
  // with a from/to payload rather than four near-identical types, so a
  // subscriber cannot miss a transition by subscribing to the wrong one.
  WORLD_STATUS_CHANGED: "WORLD_STATUS_CHANGED",
  AGENT_ACTIVITY_STARTED: "AGENT_ACTIVITY_STARTED",
  AGENT_ACTIVITY_COMPLETED: "AGENT_ACTIVITY_COMPLETED",
  AGENT_GOAL_CREATED: "AGENT_GOAL_CREATED",
  AGENT_GOAL_UPDATED: "AGENT_GOAL_UPDATED",
  AGENT_GOAL_COMPLETED: "AGENT_GOAL_COMPLETED",

  // Security
  LOGIN_SUCCEEDED: "LOGIN_SUCCEEDED",
  LOGIN_FAILED: "LOGIN_FAILED",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface EventPayloadMap {
  WORLD_CREATED: { worldId: string; name: string };
  WORLD_TICK: { worldId: string; simulatedNow: string; phase: string };
  LOCATION_CHANGED: { agentId: string; fromLocationId: string | null; toLocationId: string | null };

  COMPANY_CREATED: { companyId: string; name: string; ownerId: string };
  COMPANY_STRUCTURE_MODIFIED: { companyId: string; change: string };
  DEPARTMENT_CREATED: { companyId: string; departmentId: string; name: string };

  AGENT_CREATED: { agentId: string; name: string; roleKey: string };
  AGENT_STATE_CHANGED: {
    agentId: string;
    fromState: string | null;
    toState: string;
    activity: string | null;
  };
  AGENT_MEMORY_STORED: { agentId: string; memoryId: string; kind: string; importance: number };
  AGENT_BLUEPRINT_REQUESTED: { blueprintId: string; requestedByAgentId: string | null; name: string };
  AGENT_RUN_STARTED: { agentId: string; conversationId: string | null; trigger: string };
  AGENT_RUN_FINISHED: {
    agentId: string;
    iterations: number;
    toolCalls: number;
    durationMs: number;
    outcome: "COMPLETED" | "FAILED" | "AWAITING_APPROVAL";
  };

  CONVERSATION_CREATED: { conversationId: string; kind: string; title: string };
  MESSAGE_SENT: {
    messageId: string;
    conversationId: string;
    senderType: string;
    senderId: string | null;
    kind: string;
    notifyAgentId?: string | null;
  };

  TASK_CREATED: { taskId: string; title: string; createdByAgentId: string | null };
  TASK_ASSIGNED: { taskId: string; assigneeAgentId: string; assignedByAgentId: string | null };
  TASK_STARTED: { taskId: string; assigneeAgentId: string | null };
  TASK_COMPLETED: { taskId: string; assigneeAgentId: string | null; result: string | null };
  TASK_FAILED: { taskId: string; error: string };
  TASK_STATUS_CHANGED: { taskId: string; fromStatus: string; toStatus: string };
  TASK_CANCELLED: { taskId: string; reason: string | null };

  MONEY_TRANSFERRED: {
    transferGroupId: string;
    fromWalletId: string;
    toWalletId: string;
    amountMinor: number;
    currency: string;
  };
  MONEY_DEPOSITED: { walletId: string; amountMinor: number; currency: string };
  MONEY_WITHDRAWN: { walletId: string; amountMinor: number; currency: string };
  SALARY_PAID: {
    transactionId: string;
    agentId: string;
    amountMinor: number;
    currency: string;
  };
  PURCHASE_MADE: { transactionId: string; agentId: string | null; amountMinor: number; description: string };
  TRANSACTION_RECORDED: { transactionId: string; walletId: string; type: string; direction: string; amountMinor: number };

  APPROVAL_REQUESTED: { approvalRequestId: string; action: string; risk: string; requesterAgentId: string | null };
  APPROVAL_GRANTED: { approvalRequestId: string; action: string; decidedByUserId: string };
  APPROVAL_REJECTED: { approvalRequestId: string; action: string; decidedByUserId: string };
  APPROVAL_EXPIRED: { approvalRequestId: string; action: string };

  PLAN_CREATED: { planId: string; title: string; createdByAgentId: string | null };
  PLAN_STATUS_CHANGED: { planId: string; fromStatus: string; toStatus: string };
  PLAN_APPROVED: { planId: string; approvedByUserId: string };
  TASK_REVIEWED: {
    taskId: string;
    attempt: number;
    reviewerAgentId: string | null;
    outcome: string;
  };
  REPORT_WRITTEN: {
    reportId: string;
    taskId: string | null;
    kind: string;
    authorAgentId: string | null;
  };
  ESCALATION_RAISED: {
    escalationId: string;
    taskId: string | null;
    category: string;
    raisedByAgentId: string;
    toAgentId: string | null;
  };
  ESCALATION_RESOLVED: { escalationId: string; resolution: string; resolvedByAgentId: string | null };
  DECISION_CONFLICT_RAISED: { conflictId: string; subject: string; raisedByAgentId: string };
  DECISION_CONFLICT_RESOLVED: { conflictId: string; resolution: string; resolvedByAgentId: string | null };
  SESSION_STARTED: { sessionId: string; agentId: string; trigger: string };
  SESSION_FINISHED: { sessionId: string; agentId: string; status: string };

  TOOL_INVOKED: { toolName: string; agentId: string | null; status: string; durationMs: number };
  TOOL_DENIED: { toolName: string; agentId: string | null; reason: string; requiredPermission: string | null };

  AGENT_OBSERVATION: {
    agentId: string;
    category: string;
    note: string;
  };

  WORLD_STATUS_CHANGED: {
    worldId: string;
    fromStatus: string;
    toStatus: string;
    timeScale: number;
  };
  AGENT_ACTIVITY_STARTED: {
    agentId: string;
    activityId: string;
    type: string;
    locationId: string | null;
  };
  AGENT_ACTIVITY_COMPLETED: {
    agentId: string;
    activityId: string;
    type: string;
    durationSimMinutes: number;
  };
  AGENT_GOAL_CREATED: { agentId: string; goalId: string; title: string; priority: string };
  AGENT_GOAL_UPDATED: { agentId: string; goalId: string; status: string; progress: number };
  AGENT_GOAL_COMPLETED: { agentId: string; goalId: string; title: string };

  LOGIN_SUCCEEDED: { userId: string; email: string };
  LOGIN_FAILED: { email: string; reason: string };
}

export type EventPayload<T extends EventType = EventType> = EventPayloadMap[T];
