/**
 * Agent 2 platform tests: vendor catalog, constrained routing, connector
 * transports, MCP platform tools, QA adapters, and factory intelligence
 * (project mapping, team suggestions, fix loop, review gate, deploys).
 *
 * Discipline: nothing here asserts a fake pass. Unavailable infrastructure
 * is asserted as unavailable (ERROR/simulated/BLOCKED), and real checks are
 * asserted only when they genuinely execute.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../packages/database/src/client.js";
import { createTestUser, createTestAgent, unique, SYSTEM, CORRELATION } from "./helpers.js";
import { resetConfigCache } from "../packages/shared/src/index.js";
import { resetVaultKeyCache } from "../packages/vault/src/index.js";
import {
  setProviderRegistry,
  getProviderRegistry,
  ProviderRegistry,
  MockProvider,
  modelRegistry,
  describeVendorCatalog,
  VENDOR_CATALOG,
  routeModel,
  complete,
} from "../packages/ai/src/index.js";
import { callConnector, getDescriptor, marketplaceCatalog } from "../packages/connectors/src/index.js";
import { createCredential, revokeCredential } from "../packages/vault/src/index.js";
import { createApiKey } from "../packages/security/src/api-keys.js";
import { handleMcpRequest } from "../packages/mcp/src/index.js";
import { createWorkspace, type WorkspaceActorContext } from "../packages/workspace/src/index.js";
import {
  runTestSuite,
  startFactoryRun,
  advanceFactoryRun,
  GithubClient,
  lifecycleFor,
  getProjectStatus,
  suggestTeam,
  analyzeFailure,
  createFixTask,
  reviewRun,
  deployRun,
  refreshDeployments,
} from "../packages/factory/src/index.js";

beforeAll(() => {
  resetConfigCache();
  resetVaultKeyCache();
  setProviderRegistry(new ProviderRegistry([new MockProvider()]));
});

afterAll(() => {
  setProviderRegistry(null);
});

async function createCompany(): Promise<string> {
  const user = await createTestUser();
  const company = await prisma.company.create({
    data: { name: unique("Platform Co"), ownerId: user.id },
  });
  return company.id;
}

describe("vendor catalog", () => {
  it("lists every mission vendor exactly once, honestly marked unavailable", () => {
    const catalog = describeVendorCatalog();
    expect(catalog.length).toBe(VENDOR_CATALOG.length);
    for (const vendor of ["openai", "mistral", "groq", "cohere", "xai", "deepseek", "openrouter", "together", "fireworks", "perplexity", "cerebras", "azure-openai", "aws-bedrock", "google-vertex", "huggingface", "ollama", "vllm", "llamacpp"]) {
      const entry = catalog.find((candidate) => candidate.vendorId === vendor);
      expect(entry, `vendor ${vendor} catalogued`).toBeDefined();
      // Test env has no vendor keys: unavailable, with an enable hint.
      expect(entry?.configured).toBe(false);
      expect(entry?.envHint.length).toBeGreaterThan(0);
    }
  });

  it("registers vendor models as unavailable advisory data, never as live providers", () => {
    const mistral = modelRegistry.list({ providerId: "mistral" });
    expect(mistral.length).toBeGreaterThan(0);
    expect(mistral.every((model) => model.available === false)).toBe(true);
    // The live registry (mock only here) must not contain vendor ids.
    expect(getProviderRegistry().has("mistral")).toBe(false);
  });
});

describe("constrained routing", () => {
  it("routes unconstrained reasoning work to the honest fallback in test env", () => {
    const route = routeModel({ capability: "planning" });
    expect(route.providerId).toBe("mock");
    expect(route.fallback).toBe(true);
  });

  it("honours a satisfiable budget constraint without crashing", () => {
    const route = routeModel({ capability: "software", maxCostPer1k: 1_000_000 });
    expect(route.providerId).toBe("mock");
  });

  it("skips providers whose models cannot meet an impossible context window", () => {
    // No provider serves 100M tokens: the router must say fallback, not invent one.
    const route = routeModel({ capability: "software", minContextWindow: 100_000_000 });
    expect(route.providerId).toBe("mock");
    expect(route.fallback).toBe(true);
  });

  it("gateway threads budget constraints into fallback ranking and tracks usage", async () => {
    const agent = await createTestAgent();
    const before = await prisma.aiUsage.count();
    const result = await complete(
      prisma,
      {
        model: "",
        messages: [{ role: "user", content: "hello" }],
        routing: { capability: "software", maxCostPer1k: 1_000_000 },
        agentId: agent.id,
      },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    expect(result.providerId).toBe("mock");
    expect(await prisma.aiUsage.count()).toBe(before + 1);
  });
});

describe("connector transports", () => {
  it("carries marketplace metadata on every descriptor", () => {
    for (const descriptor of marketplaceCatalog()) {
      expect(descriptor.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(descriptor.category.length).toBeGreaterThan(0);
      expect(descriptor.provider.length).toBeGreaterThan(0);
      expect(descriptor.requiredScopes).toContain("connector.use");
      expect(descriptor.security.dataAccess.length).toBeGreaterThan(0);
    }
    expect(marketplaceCatalog().map((descriptor) => descriptor.slug)).toContain("graphql");
    expect(marketplaceCatalog().map((descriptor) => descriptor.slug)).toContain("webhook-out");
  });

  it("executes GraphQL with a vault token the caller never sees", async () => {
    await createTestUser();
    const token = `gql_${unique("tok")}`;
    const cred = await createCredential(
      prisma,
      { name: unique("gql-cred"), scope: "CONNECTOR", refId: "graphql", secret: token, metadata: { baseUrl: "https://api.example.com/graphql" } },
      { actor: SYSTEM },
    );
    let seenAuth: string | null = null;
    let seenBody = "";
    const fakeFetch: typeof fetch = async (_url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ data: { viewer: { login: "octo" } } }), { status: 200 });
    };
    const agent = await createTestAgent();
    const result = await callConnector(
      { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: fakeFetch },
      { slug: "graphql", action: "query", args: { query: "{ viewer { login } }", variables: "{\"a\":1}" } },
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ data: { viewer: { login: "octo" } } });
    expect(seenAuth).toBe(`Bearer ${token}`);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(seenBody).toContain("viewer");
    await revokeCredential(prisma, cred.id, { actor: SYSTEM });
  });

  it("posts outbound webhooks without forwarding any credential", async () => {
    let seenAuth: string | null = "unset";
    const fakeFetch: typeof fetch = async (_url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response("ok", { status: 200 });
    };
    const agent = await createTestAgent();
    const result = await callConnector(
      { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: fakeFetch },
      { slug: "webhook-out", action: "post", args: { url: "https://hooks.example.com/deploy", body: "{\"ref\":\"main\"}" } },
    );
    expect(result.ok).toBe(true);
    expect(seenAuth).toBeNull();
  });

  it("rejects non-JSON webhook bodies and non-http URLs", async () => {
    const agent = await createTestAgent();
    await expect(
      callConnector(
        { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: fetch },
        { slug: "webhook-out", action: "post", args: { url: "https://hooks.example.com/x", body: "not-json" } },
      ),
    ).rejects.toThrow();
    await expect(
      callConnector(
        { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: fetch },
        { slug: "webhook-out", action: "post", args: { url: "ftp://hooks.example.com/x", body: "{}" } },
      ),
    ).rejects.toThrow();
  });

  it("reports unconfigured bridges as unavailable without touching the network", async () => {
    const agent = await createTestAgent();
    let fetched = false;
    const spyFetch: typeof fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    for (const slug of ["cli", "database", "mcp-bridge", "websocket"]) {
      const action = getDescriptor(slug).actions[0]?.name ?? "";
      await expect(
        callConnector(
          { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: spyFetch },
          { slug, action, args: {} },
        ),
      ).rejects.toThrow(/not configured/);
    }
    expect(fetched).toBe(false);
  });
});

describe("mcp platform tools", () => {
  async function scopedKey(scopes: string[]): Promise<string> {
    const user = await createTestUser();
    const ownerPermissions = new Set([
      "agent.read", "company.read", "task.read", "task.create", "memory.read",
      "wallet.read", "testing.read", "factory.read", "provider.read",
      "connector.read", "webhook.read", "approval.read", "session.read",
      "workspace.read", "plan.read",
    ]);
    const created = await createApiKey(
      prisma,
      { name: unique("mcp-platform"), scopes, userId: user.id, ownerPermissions },
      { actor: SYSTEM },
    );
    return created.secret;
  }

  it("lists the new tools and serves scoped platform calls", async () => {
    const secret = await scopedKey(["factory.read", "provider.read", "connector.read", "approval.read", "plan.read"]);
    const listed = await handleMcpRequest({ db: prisma, apiKey: secret }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = ((listed.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    for (const tool of ["factory.list_runs", "factory.get_run", "providers.list", "models.list", "connectors.list", "webhooks.list", "approvals.list", "sessions.list", "workspaces.list", "plans.list"]) {
      expect(names).toContain(tool);
    }

    const providers = await handleMcpRequest(
      { db: prisma, apiKey: secret },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "providers.list", arguments: {} } },
    );
    expect(providers.result).toBeDefined();

    const connectors = await handleMcpRequest(
      { db: prisma, apiKey: secret },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "connectors.list", arguments: {} } },
    );
    const connectorSlugs = (((connectors.result as { structuredContent: { connectors: Array<{ slug: string }> } }).structuredContent).connectors).map((c) => c.slug);
    expect(connectorSlugs).toContain("graphql");

    // Missing scope -> denied, never served.
    const denied = await handleMcpRequest(
      { db: prisma, apiKey: secret },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "economy.status", arguments: {} } },
    );
    expect(denied.error).toMatchObject({ code: -32003 });
  });

  it("reads the new scoped resources", async () => {
    const secret = await scopedKey(["factory.read", "approval.read", "workspace.read", "plan.read", "session.read"]);
    const companyId = await createCompany();
    const run = await startFactoryRun(prisma, { repoUrl: "https://github.com/acme/widgets", companyId, actor: SYSTEM });
    const resource = await handleMcpRequest(
      { db: prisma, apiKey: secret },
      { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: `factory://${run.id}` } },
    );
    expect(resource.result).toBeDefined();
  });
});

describe("qa adapters", () => {
  it("security adapter runs real self-checks and passes on evidence", async () => {
    const row = await runTestSuite(prisma, { suite: "SECURITY", adapter: "security", name: "platform self-check" });
    expect(row.suite).toBe("SECURITY");
    expect(row.status).toBe("PASSED");
    const evidence = JSON.parse(row.evidence) as { observed: string[] };
    expect(evidence.observed.some((line) => line.startsWith("PASS:"))).toBe(true);
  });

  it("performance adapter measures real latencies and stores them", async () => {
    const row = await runTestSuite(prisma, { suite: "PERFORMANCE", adapter: "performance" });
    expect(row.suite).toBe("PERFORMANCE");
    expect(row.status).toBe("PASSED");
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    const evidence = JSON.parse(row.evidence) as { observed: string[] };
    expect(evidence.observed.length).toBeGreaterThanOrEqual(5);
  });

  it("browser and mobile without runners record simulated ERROR rows, never passes", async () => {
    const browser = await runTestSuite(prisma, { suite: "BROWSER", name: "no runner" });
    expect(browser.status).toBe("ERROR");
    expect(browser.adapter).toBe("browser");
    const browserEvidence = JSON.parse(browser.evidence) as { simulated: boolean };
    expect(browserEvidence.simulated).toBe(true);

    const mobile = await runTestSuite(prisma, { suite: "MOBILE", adapter: "mobile" });
    expect(mobile.status).toBe("ERROR");
    const mobileEvidence = JSON.parse(mobile.evidence) as { simulated: boolean };
    expect(mobileEvidence.simulated).toBe(true);
  });

  it("browser with an unreachable url records a real FAILED probe", async () => {
    const row = await runTestSuite(prisma, { adapter: "browser", url: "http://127.0.0.1:9/health" });
    expect(row.suite).toBe("BROWSER");
    expect(row.status).toBe("FAILED");
  });
});

describe("factory intelligence", () => {
  it("maps pipeline stages onto the managed-project lifecycle", () => {
    expect(lifecycleFor("INTAKE", {}, {}, {})).toBe("DISCOVERING");
    expect(lifecycleFor("ANALYZING", {}, {}, {})).toBe("ANALYZING");
    expect(lifecycleFor("PLANNING", {}, {}, {})).toBe("PLANNING");
    expect(lifecycleFor("PLANNING", { team: {} }, {}, {})).toBe("TEAM_FORMING");
    expect(lifecycleFor("BUILDING", {}, {}, {})).toBe("DEVELOPING");
    expect(lifecycleFor("BUILDING", { branch: "agentworld/x" }, {}, {})).toBe("READY");
    expect(lifecycleFor("FIXING", {}, { fixAttempts: 3 }, { maxFixAttempts: 3 })).toBe("BLOCKED");
    expect(lifecycleFor("FIXING", {}, { fixAttempts: 1 }, { maxFixAttempts: 3 })).toBe("FIXING");
    expect(lifecycleFor("AWAITING_APPROVAL", { prNumber: 7 }, {}, {})).toBe("PR_OPEN");
    expect(lifecycleFor("COMPLETED", { mergedBy: "u" }, {}, {})).toBe("MERGED");
    expect(lifecycleFor("COMPLETED", { mergedBy: "u", deployments: [{ id: "d", status: "DEPLOYED" }] }, {}, {})).toBe("DEPLOYED");
    expect(lifecycleFor("FAILED", {}, {}, {})).toBe("FAILED");
    expect(lifecycleFor("CANCELLED", {}, {}, {})).toBe("CANCELLED");
  });

  it("exposes a fresh run as a DISCOVERING project", async () => {
    const companyId = await createCompany();
    const run = await startFactoryRun(prisma, { repoUrl: "https://github.com/acme/widgets", companyId, actor: SYSTEM });
    const project = await getProjectStatus(prisma, run.id);
    expect(project.lifecycle).toBe("DISCOVERING");
    expect(project.bounds.maxFixAttempts).toBeGreaterThan(0);
    expect(project.blocked).toBe(false);
  });

  it("suggests a team without assigning anyone", async () => {
    await createTestAgent({ roleKey: "EXECUTOR" });
    const suggestion = await suggestTeam(prisma, { requiredSkills: ["testing"], taskType: "TESTING", limit: 3 });
    expect(suggestion.candidates.length).toBeGreaterThan(0);
    expect(suggestion.candidates[0]?.reasons.length).toBeGreaterThan(0);
    await expect(suggestTeam(prisma, {})).rejects.toThrow();
  });

  it("reports NO_EVIDENCE before any test, and refuses a fix task", async () => {
    const companyId = await createCompany();
    const run = await startFactoryRun(prisma, { repoUrl: "https://github.com/acme/widgets", companyId, actor: SYSTEM });
    const analysis = await analyzeFailure(prisma, run.id);
    expect(analysis.verdict).toBe("NO_EVIDENCE");
    await expect(createFixTask(prisma, run.id, { actor: SYSTEM })).rejects.toThrow(/NO_EVIDENCE/);
  });

  it("creates exactly one fix task from a real failure, bounded by budget", async () => {
    const companyId = await createCompany();
    const agent = await createTestAgent();
    const task = await prisma.task.create({
      data: { title: unique("factory work"), companyId, assigneeAgentId: agent.id, type: "IMPLEMENTATION" },
    });
    const run = await startFactoryRun(prisma, { repoUrl: "https://github.com/acme/widgets", companyId, actor: SYSTEM });
    await prisma.factoryRun.update({ where: { id: run.id }, data: { taskId: task.id } });

    const failed = await runTestSuite(prisma, { adapter: "http", url: "http://127.0.0.1:9/health", taskId: task.id });
    expect(failed.status).toBe("FAILED");

    const analysis = await analyzeFailure(prisma, run.id);
    expect(analysis.verdict).toBe("ACTIONABLE_FAILURE");
    expect(analysis.lastTestRun?.id).toBe(failed.id);
    expect(analysis.budgetRemaining).toBeGreaterThan(0);

    const { taskId } = await createFixTask(prisma, run.id, { actor: SYSTEM });
    const fix = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(fix.parentTaskId).toBe(task.id);
    expect(fix.priority).toBe("HIGH");
  });

  it("review gate fails a fresh run on missing evidence, never weakened", async () => {
    const companyId = await createCompany();
    const run = await startFactoryRun(prisma, { repoUrl: "https://github.com/acme/widgets", companyId, actor: SYSTEM });
    const verdict = await reviewRun(prisma, run.id, { actor: SYSTEM, correlationId: CORRELATION });
    expect(verdict.passed).toBe(false);
    expect(verdict.failedChecks).toContain("tests-pass");
    const stored = await prisma.factoryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.github).toContain("tests-pass");
  });

  it("deploy refuses pre-gate runs and records BLOCKED otherwise", async () => {
    const companyId = await createCompany();
    const run = await startFactoryRun(prisma, { repoUrl: "https://github.com/acme/widgets", companyId, actor: SYSTEM });
    await expect(deployRun(prisma, run.id, { target: "vercel" }, { actor: SYSTEM })).rejects.toThrow(/approval gate/);

    await prisma.factoryRun.update({ where: { id: run.id }, data: { currentStage: "AWAITING_APPROVAL", status: "AWAITING_APPROVAL" } });
    const blocked = await deployRun(prisma, run.id, { target: "vercel", environment: "production" }, { actor: SYSTEM });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.error).toContain("VERCEL_TOKEN");

    const deployments = await refreshDeployments(prisma, run.id, { actor: SYSTEM });
    expect(deployments.some((deployment) => deployment.id === blocked.id)).toBe(true);
  });
});

describe("factory testing-stage integrity", () => {
  const SYSTEM_CTX: WorkspaceActorContext = { actor: SYSTEM, correlationId: CORRELATION };

  async function workspaceBoundRun(companyId: string): Promise<{ runId: string; workspaceId: string; root: string }> {
    const root = mkdtempSync(join(tmpdir(), "agentworld-factory-"));
    const workspace = await createWorkspace(prisma, { name: unique("Factory WS") }, SYSTEM_CTX, { root });
    const run = await startFactoryRun(prisma, {
      repoUrl: "https://github.com/acme/widgets",
      companyId,
      actor: SYSTEM,
      workspaceId: workspace.id,
    });
    await prisma.factoryRun.update({
      where: { id: run.id },
      data: { currentStage: "TESTING", status: "TESTING" },
    });
    return { runId: run.id, workspaceId: workspace.id, root };
  }

  it("never borrows another run's test evidence", async () => {
    const companyId = await createCompany();
    // A green verdict that belongs to somebody else must not move this run.
    const unrelated = await runTestSuite(prisma, { adapter: "security", name: "unrelated green run" });
    expect(unrelated.status).toBe("PASSED");

    const run = await startFactoryRun(prisma, {
      repoUrl: "https://github.com/acme/widgets",
      companyId,
      actor: SYSTEM,
    });
    await prisma.factoryRun.update({
      where: { id: run.id },
      data: { currentStage: "TESTING", status: "TESTING" },
    });

    await expect(advanceFactoryRun(prisma, run.id, new GithubClient())).rejects.toThrow(
      /no task or workspace bound/,
    );
    const after = await prisma.factoryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.currentStage).toBe("TESTING");
  });

  it("queues exactly one verification while a job is in flight", async () => {
    const companyId = await createCompany();
    const { runId, workspaceId, root } = await workspaceBoundRun(companyId);
    try {
      const first = await advanceFactoryRun(prisma, runId, new GithubClient());
      expect(first.currentStage).toBe("TESTING");
      expect(await prisma.testRun.count({ where: { workspaceId } })).toBe(1);
      const queued = await prisma.testRun.findFirstOrThrow({ where: { workspaceId } });
      expect(queued.status).toBe("QUEUED");
      const jobs = await prisma.executionJob.count({ where: { workspaceId } });

      // Re-advancing while the job is in flight must not spawn a duplicate.
      const second = await advanceFactoryRun(prisma, runId, new GithubClient());
      expect(second.currentStage).toBe("TESTING");
      expect(await prisma.testRun.count({ where: { workspaceId } })).toBe(1);
      expect(await prisma.executionJob.count({ where: { workspaceId } })).toBe(jobs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("consumes a failing verdict once, fixes, then queues a real retest", async () => {
    const companyId = await createCompany();
    const { runId, workspaceId, root } = await workspaceBoundRun(companyId);
    try {
      await prisma.testRun.create({
        data: {
          suite: "UNIT",
          adapter: "command",
          name: "failing verification",
          status: "FAILED",
          summary: JSON.stringify({ passed: 0, failed: 1, skipped: 0, total: 1 }),
          evidence: JSON.stringify({ observed: ["1 test failed"], inferred: [], hypothesis: [] }),
          workspaceId,
          correlationId: CORRELATION,
        },
      });

      const fixing = await advanceFactoryRun(prisma, runId, new GithubClient());
      expect(fixing.currentStage).toBe("FIXING");

      const backToTesting = await advanceFactoryRun(prisma, runId, new GithubClient());
      expect(backToTesting.currentStage).toBe("TESTING");

      // The stale verdict was already acted on, so TESTING queues a retest
      // instead of re-entering FIXING with the same evidence.
      const retesting = await advanceFactoryRun(prisma, runId, new GithubClient());
      expect(retesting.currentStage).toBe("TESTING");
      expect(await prisma.testRun.count({ where: { workspaceId } })).toBe(2);
      const stats = JSON.parse(retesting.stats) as { consumedTestRunId?: string };
      expect(typeof stats.consumedTestRunId).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("advances to review on a passing verdict", async () => {
    const companyId = await createCompany();
    const { runId, workspaceId, root } = await workspaceBoundRun(companyId);
    try {
      await prisma.testRun.create({
        data: {
          suite: "UNIT",
          adapter: "command",
          name: "passing verification",
          status: "PASSED",
          summary: JSON.stringify({ passed: 1, failed: 0, skipped: 0, total: 1 }),
          evidence: JSON.stringify({ observed: ["exit 0"], inferred: [], hypothesis: [] }),
          workspaceId,
          correlationId: CORRELATION,
        },
      });
      const reviewing = await advanceFactoryRun(prisma, runId, new GithubClient());
      expect(reviewing.currentStage).toBe("REVIEWING");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
