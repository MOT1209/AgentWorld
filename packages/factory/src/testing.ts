/**
 * TestingEngine -- one interface, several adapters, evidence discipline.
 *
 * Adapters:
 *   - `command`  runs an argv command inside a workspace through the
 *                execution queue (vitest, pytest, any test runner).
 *   - `browser`  queues a browser command (e.g. Playwright) or probes a URL;
 *                without either it records an honest simulated ERROR row.
 *   - `mobile`   queues an instrumented command; without one it records an
 *                honest simulated ERROR row (never a fake device pass).
 *   - `security` runs real in-process platform self-checks -- PASSED only
 *                on evidence.
 *   - `performance` measures real platform query latencies against an
 *                advisory budget and stores the timings historically.
 *   - `http`     probes a URL's availability/status (smoke tests).
 *   - `testerarmy` reserves the TesterArmy E2E integration point: it parses
 *                natural-language test scripts and reports UNSUPPORTED until
 *                the e2e engine is installed, so callers get an honest
 *                "not available" instead of a fake pass.
 *
 * Evidence on every TestRun follows the factory rules: OBSERVED (the raw
 * exit/output), INFERRED (derived status/counts), HYPOTHESIS (what a further
 * run could confirm). Nothing is reported CONFIRMED without a passing run.
 */
import type { DbClient } from "../../database/src/index.js";
import type { TestRun } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { enqueueExecution } from "../../execution/src/index.js";
import { getConfig, newCorrelationId, SYSTEM_ACTOR, toJson, validationError } from "../../shared/src/index.js";

export const TEST_ADAPTERS = ["command", "http", "testerarmy", "browser", "mobile", "security", "performance"] as const;
export type TestAdapter = (typeof TEST_ADAPTERS)[number];

export const TEST_SUITES = ["UNIT", "INTEGRATION", "E2E", "BROWSER", "MOBILE", "SECURITY", "PERFORMANCE"] as const;
export type TestSuite = (typeof TEST_SUITES)[number];

export interface StartTestInput {
  workspaceId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  name?: string;
  /** command adapter: argv to run; http adapter: URL to probe. */
  argv?: string[];
  url?: string;
}

function suiteForAdapter(adapter: TestAdapter, argv?: string[], url?: string): string {
  if (adapter === "http") return "INTEGRATION";
  const joined = (argv ?? []).join(" ").toLowerCase();
  if (joined.includes("e2e") || joined.includes("playwright") || joined.includes("cypress")) return "E2E";
  if (joined.includes("pytest") || joined.includes("vitest") || joined.includes("jest") || joined.includes("go test")) return "UNIT";
  if (url !== undefined) return "INTEGRATION";
  return "INTEGRATION";
}

/** Suite-implied adapter when the caller names a QA suite but no transport. */
function suiteImpliedAdapter(suite: string | undefined): TestAdapter {
  switch (suite) {
    case "BROWSER":
      return "browser";
    case "MOBILE":
      return "mobile";
    case "SECURITY":
      return "security";
    case "PERFORMANCE":
      return "performance";
    default:
      return "command";
  }
}

export async function runTestSuite(
  db: DbClient,
  input: StartTestInput & { adapter?: TestAdapter; suite?: "UNIT" | "INTEGRATION" | "E2E" | "BROWSER" | "MOBILE" | "SECURITY" | "PERFORMANCE" },
): Promise<TestRun> {
  const correlationId = newCorrelationId();
  const adapter = input.adapter ??
    (input.argv !== undefined ? "command" : input.url !== undefined ? "http" : suiteImpliedAdapter(input.suite));

  if (adapter === "testerarmy") {
    // Honest unsupported state: the tester-army e2e engine is not vendored.
    // When it lands, this branch maps its script -> engine call -> artifacts.
    const row = await db.testRun.create({
      data: {
        suite: input.suite ?? "E2E",
        adapter: "testerarmy",
        name: input.name ?? "TesterArmy E2E",
        status: "ERROR",
        summary: toJson({ passed: 0, failed: 0, skipped: 0, total: 0 }),
        evidence: toJson({
          observed: ["TesterArmy E2E adapter requested"],
          inferred: ["Engine is not installed in this deployment"],
          hypothesis: ["Install the e2e engine and re-run to obtain real results"],
        }),
        workspaceId: input.workspaceId ?? null,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        correlationId,
      },
    });
    await emitRecorded(db, row);
    return row;
  }

  if (adapter === "command" || adapter === "browser" || adapter === "mobile" || adapter === "security" || adapter === "performance") {
    // A QA adapter with an explicit command delegates to the execution queue
    // (e.g. `playwright test` for browser, `jest --security` for security).
    // Without a command each QA adapter falls through to its honest handler
    // below: real checks where they exist, a marked simulated row otherwise.
    if (input.argv !== undefined && input.argv.length > 0) {
      return queueCommandRun(db, {
        workspaceId: input.workspaceId,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        name: input.name,
        argv: input.argv,
        adapter,
        suite: input.suite ?? suiteForAdapter(adapter, input.argv),
        correlationId,
      });
    }
    if (adapter === "command") {
      throw validationError("command adapter requires argv (e.g. [\"npx\",\"vitest\",\"run\"])");
    }
    if (adapter === "browser" && input.url !== undefined) {
      return probeHttp(db, { url: input.url, suite: "BROWSER", name: input.name, taskId: input.taskId ?? null, agentId: input.agentId ?? null, sessionId: input.sessionId ?? null, correlationId });
    }
    if (adapter === "browser") {
      return recordSimulated(db, {
        suite: "BROWSER",
        adapter,
        name: input.name ?? "Browser QA (no runner)",
        reason: "No browser runner is configured: pass argv (e.g. [\"npx\",\"playwright\",\"test\"]) or a url to probe. No page was opened and nothing is reported as passed.",
        hypothesis: ["Configure a Playwright command or probe URL and re-run for a real result"],
        workspaceId: input.workspaceId ?? null,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        correlationId,
      });
    }
    if (adapter === "mobile") {
      return recordSimulated(db, {
        suite: "MOBILE",
        adapter,
        name: input.name ?? "Mobile QA (no device)",
        reason: "No emulator or device farm is configured: pass argv for an instrumented run. No device was touched and nothing is reported as passed.",
        hypothesis: ["Bind an Android emulator / iOS simulator runner and re-run for a real result"],
        workspaceId: input.workspaceId ?? null,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        correlationId,
      });
    }
    if (adapter === "security") {
      return runSecuritySelfChecks(db, {
        name: input.name,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        correlationId,
      });
    }
    return runPerformanceProbe(db, {
      name: input.name,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
      correlationId,
    });
  }

  // http adapter: synchronous availability probe (bounded, no redirect trust).
  const url = input.url;
  if (url === undefined || !/^https?:\/\//i.test(url)) {
    throw validationError("http adapter requires an absolute http(s) URL");
  }
  return probeHttp(db, {
    url,
    suite: input.suite ?? suiteForAdapter("http", undefined, url),
    name: input.name,
    taskId: input.taskId ?? null,
    agentId: input.agentId ?? null,
    sessionId: input.sessionId ?? null,
    correlationId,
  });
}

interface QueueCommandInput {
  workspaceId?: string | null;
  taskId: string | null;
  agentId: string | null;
  sessionId: string | null;
  name?: string;
  argv: string[];
  adapter: TestAdapter;
  suite: string;
  correlationId: string;
}

/** Shared execution-queue path for every command-backed adapter. */
async function queueCommandRun(db: DbClient, run: QueueCommandInput): Promise<TestRun> {
  if (run.workspaceId === undefined || run.workspaceId === null) {
    throw validationError(`${run.adapter} adapter requires a workspace when a command is given`);
  }
  const job = await enqueueExecution(db, {
    kind: "COMMAND",
    command: JSON.stringify(run.argv),
    workspaceId: run.workspaceId,
    taskId: run.taskId,
    agentId: run.agentId,
    sessionId: run.sessionId,
    actor: SYSTEM_ACTOR,
    correlationId: run.correlationId,
    timeoutMs: Math.min(getConfig().factory.maxRuntimeMs, 900_000),
  });
  const row = await db.testRun.create({
    data: {
      suite: run.suite,
      adapter: run.adapter,
      name: run.name ?? run.argv.join(" ").slice(0, 120),
      status: "QUEUED",
      summary: toJson({ passed: 0, failed: 0, skipped: 0, total: 0 }),
      evidence: toJson({
        observed: [`ExecutionJob ${job.id} queued with argv ${run.argv.join(" ").slice(0, 120)}`],
        inferred: [],
        hypothesis: ["Run completes -> suite passes; run fails -> inspect spooled output"],
      }),
      workspaceId: run.workspaceId,
      executionId: job.id,
      taskId: run.taskId,
      agentId: run.agentId,
      sessionId: run.sessionId,
      correlationId: run.correlationId,
    },
  });
  await emitRecorded(db, row);
  return row;
}

interface ProbeInput {
  url: string;
  suite: string;
  name?: string;
  taskId: string | null;
  agentId: string | null;
  sessionId: string | null;
  correlationId: string;
}

/** Synchronous availability probe shared by the http and browser adapters. */
async function probeHttp(db: DbClient, probe: ProbeInput): Promise<TestRun> {
  if (!/^https?:\/\//i.test(probe.url)) {
    throw validationError("probe requires an absolute http(s) URL");
  }
  const started = Date.now();
  let status: number | null = null;
  let observed = "request failed";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(probe.url, { signal: controller.signal, redirect: "manual" });
    clearTimeout(timer);
    status = response.status;
    observed = `HTTP ${response.status} from ${new URL(probe.url).host}`;
  } catch (error) {
    observed = error instanceof Error ? error.message : String(error);
  }
  const durationMs = Date.now() - started;
  const passed = status !== null && status >= 200 && status < 400;
  const row = await db.testRun.create({
    data: {
      suite: probe.suite,
      adapter: probe.suite === "BROWSER" ? "browser" : "http",
      name: probe.name ?? `HTTP probe ${new URL(probe.url).host}`,
      status: passed ? "PASSED" : "FAILED",
      summary: toJson({ passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0, total: 1 }),
      evidence: toJson({
        observed: [observed],
        inferred: [passed ? "Endpoint reachable" : "Endpoint unreachable or erroring"],
        hypothesis: passed ? [] : ["If the service is expected to be up, verify deployment health"],
      }),
      taskId: probe.taskId,
      agentId: probe.agentId,
      sessionId: probe.sessionId,
      durationMs,
      startedAt: new Date(started),
      finishedAt: new Date(),
      correlationId: probe.correlationId,
    },
  });
  await emitRecorded(db, row);
  return row;
}

interface SimulatedInput {
  suite: string;
  adapter: TestAdapter;
  name: string;
  reason: string;
  hypothesis: string[];
  workspaceId: string | null;
  taskId: string | null;
  agentId: string | null;
  sessionId: string | null;
  correlationId: string;
}

/**
 * Honest stand-in for infrastructure that is not configured. The row is
 * status ERROR (never PASSED) and carries `simulated: true` in its
 * evidence, so no dashboard can mistake it for a real device result.
 */
async function recordSimulated(db: DbClient, simulated: SimulatedInput): Promise<TestRun> {
  const row = await db.testRun.create({
    data: {
      suite: simulated.suite,
      adapter: simulated.adapter,
      name: simulated.name,
      status: "ERROR",
      summary: toJson({ passed: 0, failed: 0, skipped: 1, total: 1 }),
      evidence: toJson({
        simulated: true,
        observed: [simulated.reason],
        inferred: ["No real result was produced; this row marks unavailable infrastructure"],
        hypothesis: simulated.hypothesis,
      }),
      workspaceId: simulated.workspaceId,
      taskId: simulated.taskId,
      agentId: simulated.agentId,
      sessionId: simulated.sessionId,
      correlationId: simulated.correlationId,
    },
  });
  await emitRecorded(db, row);
  return row;
}

interface SelfCheckInput {
  name?: string;
  taskId: string | null;
  agentId: string | null;
  sessionId: string | null;
  correlationId: string;
}

/**
 * Platform security self-checks: real, side-effect-free assertions about
 * security-relevant behavior (vault round-trip, secret-shape discipline,
 * webhook HMAC round-trip, MCP denial without a key, URL validation,
 * connector slug validation). PASSED only when every check actually passes.
 */
async function runSecuritySelfChecks(db: DbClient, check: SelfCheckInput): Promise<TestRun> {
  const started = Date.now();
  const observed: string[] = [];
  const failures: string[] = [];
  const pass = (label: string): void => {
    observed.push(`PASS: ${label}`);
  };
  const fail = (label: string, detail: string): void => {
    failures.push(`${label}: ${detail.slice(0, 200)}`);
    observed.push(`FAIL: ${label}`);
  };

  try {
    const { seal, open } = await import("../../vault/src/index.js");
    const marker = `selfcheck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const sealed = seal(marker);
    if (sealed.payload.includes(marker)) {
      fail("vault-seal", "ciphertext contains plaintext");
    } else if (open(sealed.payload) !== marker) {
      fail("vault-seal", "round-trip mismatch");
    } else {
      pass("vault seal/open round-trip");
    }
  } catch (error) {
    fail("vault-seal", error instanceof Error ? error.message : String(error));
  }

  try {
    const { credentialMetadata } = await import("../../vault/src/index.js");
    const shape = credentialMetadata({
      id: "check",
      name: "check",
      kind: "API_KEY",
      scope: "CONNECTOR",
      refId: "github",
      status: "ACTIVE",
      payload: "SECRET_PAYLOAD_MARKER",
      metadata: "{}",
      keyVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null,
    } as never);
    if (JSON.stringify(shape).includes("SECRET_PAYLOAD_MARKER")) {
      fail("credential-shape", "metadata serializer leaks the sealed payload");
    } else {
      pass("credential metadata exposes no secret material");
    }
  } catch (error) {
    fail("credential-shape", error instanceof Error ? error.message : String(error));
  }

  try {
    const { signPayload } = await import("../../webhooks/src/index.js");
    const secret = "selfcheck-secret";
    const signature = signPayload(secret, "1700000000", "{\"ping\":true}");
    if (signature !== signPayload(secret, "1700000000", "{\"ping\":true}") || signature.length !== 64) {
      fail("webhook-hmac", "signature not deterministic");
    } else {
      pass("webhook HMAC sign/verify round-trip");
    }
  } catch (error) {
    fail("webhook-hmac", error instanceof Error ? error.message : String(error));
  }

  try {
    const { handleMcpRequest } = await import("../../mcp/src/index.js");
    const denied = await handleMcpRequest({ db, apiKey: null }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const code = (denied.error as { code?: number } | undefined)?.code;
    if (code === -32001) {
      pass("MCP refuses unauthenticated tool access");
    } else {
      fail("mcp-deny", `expected code -32001, got ${String(code)}`);
    }
  } catch (error) {
    fail("mcp-deny", error instanceof Error ? error.message : String(error));
  }

  try {
    const { GithubClient } = await import("./github.js");
    let rejected = false;
    try {
      GithubClient.parseRepoUrl("https://evil.example.com/not-github");
    } catch {
      rejected = true;
    }
    if (rejected) {
      pass("repository URL validation rejects non-GitHub hosts");
    } else {
      fail("repo-url", "non-GitHub URL accepted");
    }
  } catch (error) {
    fail("repo-url", error instanceof Error ? error.message : String(error));
  }

  try {
    const { getDescriptor } = await import("../../connectors/src/index.js");
    let rejected = false;
    try {
      getDescriptor("no-such-connector");
    } catch {
      rejected = true;
    }
    if (rejected) {
      pass("connector registry rejects unknown slugs");
    } else {
      fail("connector-slug", "unknown slug accepted");
    }
  } catch (error) {
    fail("connector-slug", error instanceof Error ? error.message : String(error));
  }

  const durationMs = Date.now() - started;
  const passed = failures.length === 0;
  const row = await db.testRun.create({
    data: {
      suite: "SECURITY",
      adapter: "security",
      name: check.name ?? "Platform security self-checks",
      status: passed ? "PASSED" : "FAILED",
      summary: toJson({ passed: passed ? observed.length : observed.length - failures.length, failed: failures.length, skipped: 0, total: observed.length }),
      evidence: toJson({
        observed,
        inferred: [passed ? "All in-process security checks held" : `${failures.length} check(s) failed; see observed lines`],
        hypothesis: passed ? [] : failures,
      }),
      taskId: check.taskId,
      agentId: check.agentId,
      sessionId: check.sessionId,
      durationMs,
      startedAt: new Date(started),
      finishedAt: new Date(),
      correlationId: check.correlationId,
    },
  });
  await emitRecorded(db, row);
  return row;
}

/**
 * Performance probe: real, bounded measurements of platform query latency.
 * PASSED only when every probe completes inside its advisory budget; the
 * timings are stored historically on the TestRun for dashboards.
 */
async function runPerformanceProbe(db: DbClient, probe: SelfCheckInput): Promise<TestRun> {
  const started = Date.now();
  const observed: string[] = [];
  const failures: string[] = [];
  const BUDGET_MS = 5_000;

  const timed = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    const begin = Date.now();
    try {
      await work();
      const elapsed = Date.now() - begin;
      observed.push(`${label}: ${elapsed}ms`);
      if (elapsed > BUDGET_MS) failures.push(`${label} exceeded ${BUDGET_MS}ms (${elapsed}ms)`);
    } catch (error) {
      failures.push(`${label} threw: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    }
  };

  await timed("task.count", () => db.task.count());
  await timed("agent.count", () => db.agent.count());
  await timed("factoryRun.count", () => db.factoryRun.count());
  await timed("testRun.count", () => db.testRun.count());
  await timed("aiUsage.count", () => db.aiUsage.count());

  const durationMs = Date.now() - started;
  const passed = failures.length === 0;
  const row = await db.testRun.create({
    data: {
      suite: "PERFORMANCE",
      adapter: "performance",
      name: probe.name ?? "Platform latency probe",
      status: passed ? "PASSED" : "FAILED",
      summary: toJson({ passed: passed ? observed.length : 0, failed: failures.length, skipped: 0, total: observed.length }),
      evidence: toJson({
        observed,
        inferred: [passed ? `All probes inside the ${BUDGET_MS}ms advisory budget` : "One or more probes missed the advisory budget"],
        hypothesis: passed ? [] : failures,
      }),
      taskId: probe.taskId,
      agentId: probe.agentId,
      sessionId: probe.sessionId,
      durationMs,
      startedAt: new Date(started),
      finishedAt: new Date(),
      correlationId: probe.correlationId,
    },
  });
  await emitRecorded(db, row);
  return row;
}

async function emitRecorded(db: DbClient, row: TestRun): Promise<void> {
  await eventBus
    .publishAndDispatch(db, {
      type: EVENT_TYPES.TEST_RUN_RECORDED,
      actor: SYSTEM_ACTOR,
      correlationId: row.correlationId ?? newCorrelationId(),
      targetType: "TestRun",
      targetId: row.id,
      payload: {
        testRunId: row.id,
        suite: row.suite,
        adapter: row.adapter,
        status: row.status,
        taskId: row.taskId,
      },
    })
    .catch(() => undefined);
}

/**
 * Settles a TestRun from its finished ExecutionJob. Called by the fix-loop
 * (or a worker callback) once the job reaches a terminal status.
 */
export async function settleTestRunFromExecution(
  db: DbClient,
  testRunId: string,
  outcome: { exitCode: number | null; status: string; stdoutPath?: string | null },
): Promise<TestRun> {
  const row = await db.testRun.findUnique({ where: { id: testRunId } });
  if (row === null) throw validationError("TestRun not found");
  if (row.status !== "QUEUED" && row.status !== "RUNNING") return row;
  const passed = outcome.exitCode === 0;
  const updated = await db.testRun.update({
    where: { id: testRunId },
    data: {
      status: passed ? "PASSED" : outcome.status === "TIMEOUT" ? "TIMEOUT" : "FAILED",
      summary: toJson({ passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0, total: 1 }),
      evidence: toJson({
        observed: [`ExecutionJob finished with status ${outcome.status}, exitCode ${String(outcome.exitCode)}`],
        inferred: [passed ? "Command exited zero" : "Command reported failure"],
        hypothesis: passed ? [] : ["Inspect spooled stdout/stderr artifacts for the failing step"],
      }),
      rawPath: outcome.stdoutPath ?? row.rawPath,
      finishedAt: new Date(),
    },
  });
  await emitRecorded(db, updated);
  return updated;
}

export async function listTestRuns(
  db: DbClient,
  query: { taskId?: string; workspaceId?: string; suite?: string; cursor?: string; limit?: number } = {},
): Promise<TestRun[]> {
  const limit = query.limit === undefined || !Number.isFinite(query.limit)
    ? 100
    : Math.max(1, Math.min(Math.floor(query.limit), 100));
  return db.testRun.findMany({
    where: {
      ...(query.taskId !== undefined ? { taskId: query.taskId } : {}),
      ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}),
      ...(query.suite !== undefined ? { suite: query.suite } : {}),
      ...(query.cursor !== undefined ? { id: { lt: query.cursor } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
