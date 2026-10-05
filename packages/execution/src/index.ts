export {
  createBackend,
  defaultBackendId,
  type ExecutionBackend,
  type ExecutionBackendId,
  type ExecutionKind,
  type ExecutionRequest,
  type ExecutionResult,
} from "./backend.js";
export { MockExecutionBackend, type MockOutcome } from "./backends/mock.js";
export { LocalProcessBackend } from "./backends/local-process.js";
export { OpenCodeExecutionBackend, buildOpenCodeArgv } from "./backends/opencode.js";
export { runJob, parseCommand, type JobRunOutcome } from "./runner.js";
export {
  cancelExecution,
  cancelQueuedExecution,
  enqueueExecution,
  recoverOrphanedJobs,
  requeueTransientFailure,
  type EnqueueExecutionInput,
  type RecoverOptions,
} from "./queue.js";
export {
  startExecutionWorker,
  type ExecutionWorkerHandle,
  type ExecutionWorkerOptions,
} from "./worker.js";
export {
  buildVerificationReport,
  detectVerificationCommands,
  enqueueVerification,
  type EnqueueVerificationResult,
  type VerificationCommand,
} from "./verify.js";
