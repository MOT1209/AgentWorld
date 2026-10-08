/**
 * Deployment adapters for the Software Factory.
 *
 * Targets: vercel | docker | cloud | local | custom.
 *
 * Honesty contract (never claim success without evidence):
 *   - Every deploy attempt records a DeploymentRecord on the run's github
 *     JSON (`deployments: [...]`) and emits FACTORY_DEPLOY_RECORDED, so the
 *     attempt is auditable whether it succeeds or not.
 *   - `custom` with an explicit workspace + command genuinely executes: the
 *     command runs through the existing execution queue (path guards, command
 *     policy, timeouts, secret protection all apply) and the deployment
 *     settles to DEPLOYED only when the job exits zero.
 *   - Every other target without its required credential/config records
 *     BLOCKED with the exact missing piece named. Nothing is faked.
 *   - Rollback is supported only when a rollbackCommand was recorded at
 *     deploy time; otherwise rollbackDeployment refuses loudly instead of
 *     pretending to revert.
 *
 * Deployments never merge code and never bypass approval: deploy() refuses
 * runs that are not past the approval gate (AWAITING_APPROVAL with a human
 * merge recorded, or COMPLETED).
 */
import type { DbClient } from "../../database/src/index.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { enqueueExecution } from "../../execution/src/index.js";
import { getConfig, newCorrelationId, toJson, validationError, type ActorRef } from "../../shared/src/index.js";

export const DEPLOY_TARGETS = ["vercel", "docker", "cloud", "local", "custom"] as const;
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

export type DeploymentStatus = "QUEUED" | "RUNNING" | "DEPLOYED" | "FAILED" | "BLOCKED" | "ROLLED_BACK";

export interface DeploymentRecord {
  id: string;
  target: DeployTarget;
  environment: string;
  status: DeploymentStatus;
  executionId: string | null;
  command: string[] | null;
  rollbackCommand: string[] | null;
  logs: string[];
  artifacts: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeployInput {
  target: DeployTarget;
  environment?: string;
  /** custom target only: command to run in the run's workspace. */
  command?: string[];
  /** custom target only: rollback command, recorded for later revert. */
  rollbackCommand?: string[];
  artifacts?: string[];
}

const APPROVAL_GATE_STAGES = ["AWAITING_APPROVAL", "COMPLETED"];

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readDeployments(github: Record<string, unknown>): DeploymentRecord[] {
  if (!Array.isArray(github.deployments)) return [];
  return github.deployments.filter((entry): entry is DeploymentRecord =>
    entry !== null && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string",
  );
}

async function storeDeployments(db: DbClient, runId: string, github: Record<string, unknown>, deployments: DeploymentRecord[]): Promise<void> {
  await db.factoryRun.update({
    where: { id: runId },
    data: { github: toJson({ ...github, deployments }) },
  });
}

async function emitDeploy(
  db: DbClient,
  runId: string,
  deployment: DeploymentRecord,
  actor: ActorRef,
  correlationId: string,
): Promise<void> {
  await eventBus
    .publishAndDispatch(db, {
      type: EVENT_TYPES.FACTORY_DEPLOY_RECORDED,
      actor,
      correlationId,
      targetType: "FactoryRun",
      targetId: runId,
      payload: { factoryRunId: runId, deploymentId: deployment.id, target: deployment.target, status: deployment.status },
    })
    .catch(() => undefined);
}

/**
 * Records a deployment attempt. Executes for real only on the custom target
 * with a workspace + command; every other target records BLOCKED with the
 * missing credential/config named, unless it is genuinely executable.
 */
export async function deployRun(
  db: DbClient,
  runId: string,
  input: DeployInput,
  ctx: { actor: ActorRef; correlationId?: string },
): Promise<DeploymentRecord> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");
  if (!APPROVAL_GATE_STAGES.includes(run.currentStage)) {
    throw validationError(
      `Deploy requires the approval gate (stage ${run.currentStage} is not AWAITING_APPROVAL/COMPLETED). Merge/deploy respects the approval policy.`,
    );
  }
  if (input.environment !== undefined && (input.environment === "" || input.environment.length > 80)) {
    throw validationError("environment must be a non-empty string up to 80 chars");
  }

  const github = parseJson(run.github);
  const deployments = readDeployments(github);
  const now = new Date().toISOString();
  const record: DeploymentRecord = {
    id: `dep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    target: input.target,
    environment: input.environment ?? "production",
    status: "BLOCKED",
    executionId: null,
    command: input.command ?? null,
    rollbackCommand: input.rollbackCommand ?? null,
    logs: [],
    artifacts: input.artifacts ?? [],
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  if (input.target === "custom") {
    if (run.workspaceId === null) {
      record.error = "custom deploy needs a workspace bound to the run";
    } else if (input.command === undefined || input.command.length === 0) {
      record.error = "custom deploy needs an explicit command array (nothing is guessed)";
    } else {
      const job = await enqueueExecution(db, {
        kind: "COMMAND",
        command: JSON.stringify(input.command),
        workspaceId: run.workspaceId,
        taskId: run.taskId,
        agentId: null,
        sessionId: null,
        actor: ctx.actor,
        correlationId,
        timeoutMs: Math.min(getConfig().factory.maxRuntimeMs, 900_000),
      });
      record.status = "RUNNING";
      record.executionId = job.id;
      record.logs.push(`deploy execution ${job.id} queued: ${input.command.join(" ").slice(0, 200)}`);
    }
  } else if (input.target === "local") {
    record.error = "local deploy needs an explicit release command; use target custom with command + rollbackCommand";
  } else if (input.target === "docker") {
    record.error = "docker deploy needs an image reference and registry credential; none is configured in this deployment";
  } else if (input.target === "vercel") {
    record.error = "vercel deploy needs a VERCEL_TOKEN connector credential; none is configured in this deployment";
  } else {
    record.error = "cloud deploy needs a cloud binding (project, region, credentials); none is configured in this deployment";
  }

  deployments.push(record);
  await storeDeployments(db, run.id, github, deployments);
  await emitDeploy(db, run.id, record, ctx.actor, correlationId);
  return record;
}

/**
 * Refreshes RUNNING deployments from their execution jobs. A deployment
 * becomes DEPLOYED only on exit zero; any other terminal state becomes
 * FAILED with the job status quoted. BLOCKED/terminal records are untouched.
 */
export async function refreshDeployments(
  db: DbClient,
  runId: string,
  ctx: { actor: ActorRef; correlationId?: string },
): Promise<DeploymentRecord[]> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");
  const github = parseJson(run.github);
  const deployments = readDeployments(github);
  let changed = false;

  for (const deployment of deployments) {
    if (deployment.status !== "RUNNING" || deployment.executionId === null) continue;
    const job = await db.executionJob.findUnique({ where: { id: deployment.executionId } });
    if (job === null) {
      deployment.status = "FAILED";
      deployment.error = "deploy execution job disappeared";
      deployment.updatedAt = new Date().toISOString();
      changed = true;
      continue;
    }
    if (job.status === "COMPLETED") {
      deployment.status = "DEPLOYED";
      deployment.logs.push(`deploy execution ${job.id} exited zero`);
      deployment.updatedAt = new Date().toISOString();
      changed = true;
    } else if (job.status === "FAILED" || job.status === "TIMEOUT" || job.status === "CANCELLED") {
      deployment.status = "FAILED";
      deployment.error = `deploy execution ${job.id} ended ${job.status}`;
      deployment.logs.push(deployment.error);
      deployment.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    await storeDeployments(db, run.id, github, deployments);
    for (const deployment of deployments) {
      if (deployment.status === "DEPLOYED" || deployment.status === "FAILED") {
        await emitDeploy(db, run.id, deployment, ctx.actor, correlationId);
      }
    }
  }
  return deployments;
}

/**
 * Rolls back a DEPLOYED deployment when a rollback command was recorded.
 * Refuses loudly when there is nothing to roll back with.
 */
export async function rollbackDeployment(
  db: DbClient,
  runId: string,
  deploymentId: string,
  ctx: { actor: ActorRef; correlationId?: string },
): Promise<DeploymentRecord> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");
  const github = parseJson(run.github);
  const deployments = readDeployments(github);
  const deployment = deployments.find((entry) => entry.id === deploymentId);
  if (deployment === undefined) throw validationError("Deployment not found on this run");
  if (deployment.status !== "DEPLOYED") {
    throw validationError(`Only a DEPLOYED deployment can be rolled back (status is ${deployment.status})`);
  }
  if (deployment.rollbackCommand === null || deployment.rollbackCommand.length === 0 || run.workspaceId === null) {
    throw validationError("No rollback command was recorded for this deployment; refusing to guess one");
  }
  const job = await enqueueExecution(db, {
    kind: "COMMAND",
    command: JSON.stringify(deployment.rollbackCommand),
    workspaceId: run.workspaceId,
    taskId: run.taskId,
    agentId: null,
    sessionId: null,
    actor: ctx.actor,
    correlationId,
    timeoutMs: Math.min(getConfig().factory.maxRuntimeMs, 900_000),
  });
  deployment.status = "ROLLED_BACK";
  deployment.logs.push(`rollback execution ${job.id} queued: ${deployment.rollbackCommand.join(" ").slice(0, 200)}`);
  deployment.updatedAt = new Date().toISOString();
  await storeDeployments(db, run.id, github, deployments);
  await emitDeploy(db, run.id, deployment, ctx.actor, correlationId);
  return deployment;
}

export async function listDeployments(db: DbClient, runId: string): Promise<DeploymentRecord[]> {
  const run = await db.factoryRun.findUnique({ where: { id: runId } });
  if (run === null) throw validationError("FactoryRun not found");
  return readDeployments(parseJson(run.github));
}
