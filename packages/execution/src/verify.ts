/**
 * Verification pipeline — detect which test scripts a workspace can run,
 * enqueue them as VERIFY ExecutionJobs through the queue (never inline),
 * then fold the terminal job results into a Report{kind:"EXECUTION"} for
 * the review handoff. Report creation goes through writeReport so the
 * existing /reports and review surfaces pick it up unchanged.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "../../database/src/index.js";
import type { ExecutionJob, Report } from "../../database/src/types.js";
import { notFound, validationError } from "../../shared/src/index.js";
import { getWorkspace, type WorkspaceActorContext } from "../../workspace/src/index.js";
import { writeReport, type ReportActorContext } from "../../orchestration/src/index.js";
import { enqueueExecution } from "./queue.js";

export interface VerificationCommand {
  tool: string;
  label: string;
  argv: string[];
  cwd: string;
}

const PYTEST_CONFIG_FILES = ["pytest.ini", "tox.ini", "setup.cfg"];

function readPackageJson(workspacePath: string): { scripts?: Record<string, string> } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(workspacePath, "package.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      return parsed as { scripts?: Record<string, string> };
    }
    return null;
  } catch {
    return null;
  }
}

function hasPytest(workspacePath: string): boolean {
  if (PYTEST_CONFIG_FILES.some((file) => existsSync(join(workspacePath, file)))) return true;
  try {
    const pyproject = join(workspacePath, "pyproject.toml");
    if (existsSync(pyproject) && readFileSync(pyproject, "utf8").includes("[tool.pytest")) return true;
    if (existsSync(join(workspacePath, "tests"))) return true;
    return readdirSync(workspacePath).some(
      (name) => name.startsWith("test_") && name.endsWith(".py"),
    );
  } catch {
    return false;
  }
}

/**
 * Pure detection over the workspace directory: no process is spawned here,
 * nothing is enqueued — callers decide whether to run the commands.
 */
export function detectVerificationCommands(workspacePath: string): VerificationCommand[] {
  const found: VerificationCommand[] = [];

  const pkg = readPackageJson(workspacePath);
  const scripts = pkg?.scripts ?? {};
  if (typeof scripts.test === "string" && scripts.test.trim() !== "") {
    found.push({ tool: "npm", label: "npm test", argv: ["npm", "test"], cwd: workspacePath });
  } else if (typeof scripts.verify === "string" && scripts.verify.trim() !== "") {
    found.push({ tool: "npm", label: "npm run verify", argv: ["npm", "run", "verify"], cwd: workspacePath });
  }

  if (hasPytest(workspacePath)) {
    found.push({ tool: "python", label: "pytest", argv: ["python", "-m", "pytest", "-q"], cwd: workspacePath });
  }
  if (existsSync(join(workspacePath, "Cargo.toml"))) {
    found.push({ tool: "cargo", label: "cargo test", argv: ["cargo", "test"], cwd: workspacePath });
  }
  if (existsSync(join(workspacePath, "go.mod"))) {
    found.push({ tool: "go", label: "go test", argv: ["go", "test", "./..."], cwd: workspacePath });
  }
  return found;
}

export interface EnqueueVerificationResult {
  workspaceId: string;
  commands: VerificationCommand[];
  jobs: ExecutionJob[];
}

export async function enqueueVerification(
  db: DbClient,
  workspaceId: string,
  ctx: WorkspaceActorContext,
): Promise<EnqueueVerificationResult> {
  const workspace = await getWorkspace(db, workspaceId, ctx);
  const commands = detectVerificationCommands(workspace.path);
  const jobs: ExecutionJob[] = [];
  for (const [index, command] of commands.entries()) {
    const job = await enqueueExecution(db, {
      kind: "VERIFY",
      command: JSON.stringify(command.argv),
      actor: ctx.actor,
      ...(ctx.correlationId !== undefined ? { correlationId: ctx.correlationId } : {}),
      backendId: "local",
      workspaceId,
      workingDir: command.cwd,
      timeoutMs: 300_000,
      priority: 10 - index,
    });
    jobs.push(job);
  }
  return { workspaceId, commands, jobs };
}

export async function buildVerificationReport(
  db: DbClient,
  jobIds: string[],
  ctx: ReportActorContext,
  options?: { taskId?: string | null },
): Promise<Report> {
  if (jobIds.length === 0) {
    throw validationError("A verification report needs at least one job id");
  }

  const jobs: ExecutionJob[] = [];
  for (const jobId of jobIds) {
    const job = await db.executionJob.findUnique({ where: { id: jobId } });
    if (job === null) throw notFound("ExecutionJob", jobId);
    if (job.status === "QUEUED" || job.status === "RUNNING") {
      throw validationError(`Execution job ${jobId} has not finished (status ${job.status})`);
    }
    jobs.push(job);
  }

  const passed = jobs.filter((job) => job.status === "COMPLETED").length;
  const total = jobs.length;
  const failing = jobs.filter((job) => job.status !== "COMPLETED");
  const workspaceId = jobs.find((job) => job.workspaceId !== null)?.workspaceId ?? null;

  const report = await writeReport(
    db,
    {
      kind: "EXECUTION",
      summary: `Verification ${passed}/${total} checks passed`,
      payload: {
        workCompleted: `${total} verification command(s) executed`,
        workRemaining:
          failing.length > 0 ? `${failing.length} failing check(s) must be fixed` : "None",
        blockers: failing.map((job) => ({
          jobId: job.id,
          command: job.command,
          status: job.status,
          error: job.error,
        })),
        risks: [],
        filesChanged: [],
        tests: { total, passed, failed: total - passed },
        recommendations:
          failing.length > 0
            ? ["Fix the failing verification commands before requesting review"]
            : ["Ready for review"],
        workspaceId,
        jobs: jobs.map((job) => ({
          id: job.id,
          command: job.command,
          status: job.status,
          exitCode: job.exitCode,
          error: job.error,
        })),
      },
      ...(options?.taskId !== undefined ? { taskId: options.taskId } : {}),
    },
    ctx,
  );
  return report;
}
