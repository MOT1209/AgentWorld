/**
 * Tool catalogue assembly.
 *
 * The single list of what an agent can do. Adding a capability means adding one
 * file here and one entry in a role's allow-list; nothing else changes, and no
 * agent code needs to know the tool exists.
 */
import type { AnyToolDefinition } from "./types.js";
import { taskTools } from "./definitions/task-tools.js";
import { communicationTools } from "./definitions/message-tools.js";
import { memoryTools } from "./definitions/memory-tools.js";
import { economyTools } from "./definitions/economy-tools.js";
import { worldTools } from "./definitions/world-tools.js";
import { companyTools } from "./definitions/company-tools.js";
import { eventTools } from "./definitions/event-tools.js";
import { approvalTools } from "./definitions/approval-tools.js";
import { planTools } from "./definitions/plan-tools.js";
import { reviewTools } from "./definitions/review-tools.js";
import { reportTools } from "./definitions/report-tools.js";
import { escalationTools } from "./definitions/escalation-tools.js";
import { sessionTools } from "./definitions/session-tools.js";
import { workspaceTools } from "./definitions/workspace-tools.js";
import { terminalTools } from "./definitions/terminal-tools.js";
import { fsTools } from "./definitions/fs-tools.js";
import { gitTools } from "./definitions/git-tools.js";
import { ToolRegistry } from "./registry.js";

export const BUILT_IN_TOOLS: AnyToolDefinition[] = [
  ...taskTools,
  ...communicationTools,
  ...memoryTools,
  ...economyTools,
  ...worldTools,
  ...companyTools,
  ...eventTools,
  ...approvalTools,
  ...planTools,
  ...reviewTools,
  ...reportTools,
  ...escalationTools,
  ...sessionTools,
  ...workspaceTools,
  ...terminalTools,
  ...fsTools,
  ...gitTools,
];

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry(BUILT_IN_TOOLS);
}

export { ToolRegistry } from "./registry.js";
export { ToolExecutor } from "./executor.js";
export * from "./types.js";

export { taskTools, taskCreateTool, taskUpdateTool, taskListTool, taskDetailTool } from "./definitions/task-tools.js";
export { communicationTools, messageSendTool, messageReadTool } from "./definitions/message-tools.js";
export { memoryTools, memoryStoreTool, memorySearchTool, memoryForgetTool } from "./definitions/memory-tools.js";
export { economyTools, walletBalanceTool, walletTransferTool, walletStatementTool } from "./definitions/economy-tools.js";
export { worldTools, worldGetStateTool, worldGetLocationTool } from "./definitions/world-tools.js";
export { companyTools, companyInfoTool } from "./definitions/company-tools.js";
export { eventTools, eventEmitTool } from "./definitions/event-tools.js";
export { approvalTools, approvalListTool, approvalGetTool, approvalDecideTool } from "./definitions/approval-tools.js";
export { planTools, planCreateTool, planUpdateTool, planListTool, planGetTool } from "./definitions/plan-tools.js";
export { reviewTools, reviewSubmitTool } from "./definitions/review-tools.js";
export { reportTools, reportSubmitTool } from "./definitions/report-tools.js";
export { escalationTools, escalateTool } from "./definitions/escalation-tools.js";
export { sessionTools, sessionStartTool, sessionStatusTool } from "./definitions/session-tools.js";
export {
  workspaceTools,
  workspaceCreateTool,
  workspaceListTool,
  workspaceGetTool,
  workspaceStatusTool,
  workspaceShareTool,
  workspaceArchiveTool,
} from "./definitions/workspace-tools.js";
export { terminalTools, terminalExecTool, terminalKillTool } from "./definitions/terminal-tools.js";
export {
  fsTools,
  fsListTool,
  fsReadTool,
  fsWriteTool,
  fsMkdirTool,
  fsMoveTool,
  fsDeleteTool,
  fsSearchTool,
} from "./definitions/fs-tools.js";
export {
  gitTools,
  gitStatusTool,
  gitBranchTool,
  gitCheckoutTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
} from "./definitions/git-tools.js";
