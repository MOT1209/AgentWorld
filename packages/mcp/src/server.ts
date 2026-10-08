/**
 * AgentWorld MCP Server -- the official Model Context Protocol front door.
 *
 * An external AI agent connects with a scoped API key and gets a governed
 * subset of the platform. The architecture is strict:
 *
 *   External AI Agent -> MCP (this file) -> Core services -> AgentWorld
 *
 * Rules:
 *  - Every request is authenticated with an ApiKey; the key's scopes are the
 *    ONLY authority. No scope, no tool. Denials are audited (MCP_DENIED).
 *  - Tools are intentionally narrow and map to existing Core services; they
 *    never expose internal tables, provider secrets, or credentials.
 *  - Resources are read-only URIs (agent://, company://, task://, ...) with
 *    scope-checked metadata responses.
 *  - Transport-agnostic: the HTTP route hands raw JSON-RPC frames to
 *    `handleMcpRequest` and sends back the JSON-RPC response, so stdio and
 *    HTTP transports can share one implementation.
 */
import type { DbClient } from "../../database/src/index.js";
import { authenticateApiKey, assertScopesAllow, type ApiKeyAuthentication } from "../../security/src/api-keys.js";
import { PERMISSIONS } from "../../security/src/permissions.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { newCorrelationId, SYSTEM_ACTOR } from "../../shared/src/index.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "agentworld";
export const MCP_SERVER_VERSION = "1.0.0";

export interface McpToolDefinition {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: Record<string, unknown>;
  run(db: DbClient, auth: ApiKeyAuthentication, args: Record<string, unknown>): Promise<unknown>;
}

function jsonSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

const id = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length < 100 ? v : null;

// =============================================================================
// TOOLS -- every entry is an intentional external surface backed by Core.
// =============================================================================

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "agents.list",
    description: "List agents visible to the platform (id, name, role, status).",
    requiredScope: PERMISSIONS.AGENT_READ,
    inputSchema: jsonSchema({}),
    async run(db) {
      const agents = await db.agent.findMany({
        where: { isActive: true },
        select: { id: true, name: true, roleKey: true, title: true, isActive: true },
        take: 100,
      });
      return { agents };
    },
  },
  {
    name: "agents.get",
    description: "Get one agent's public profile.",
    requiredScope: PERMISSIONS.AGENT_READ,
    inputSchema: jsonSchema({ agentId: { type: "string" } }, ["agentId"]),
    async run(db, _auth, args) {
      const agentId = id(args.agentId);
      if (agentId === null) throw new Error("agentId is required");
      const agent = await db.agent.findUnique({
        where: { id: agentId },
        select: { id: true, name: true, roleKey: true, title: true, systemPrompt: false, isActive: true, reputation: true },
      });
      return { agent };
    },
  },
  {
    name: "companies.list",
    description: "List companies (id, name).",
    requiredScope: PERMISSIONS.COMPANY_READ,
    inputSchema: jsonSchema({}),
    async run(db) {
      const companies = await db.company.findMany({ select: { id: true, name: true, description: true }, take: 100 });
      return { companies };
    },
  },
  {
    name: "projects.list",
    description: "List projects for a company.",
    requiredScope: PERMISSIONS.COMPANY_READ,
    inputSchema: jsonSchema({ companyId: { type: "string" } }, ["companyId"]),
    async run(db, _auth, args) {
      const companyId = id(args.companyId);
      if (companyId === null) throw new Error("companyId is required");
      const projects = await db.project.findMany({
        where: { companyId },
        select: { id: true, name: true, status: true },
        take: 100,
      });
      return { projects };
    },
  },
  {
    name: "tasks.create",
    description: "Create a task in a company (governed by the Core task engine).",
    requiredScope: PERMISSIONS.TASK_CREATE,
    inputSchema: jsonSchema(
      {
        companyId: { type: "string" },
        title: { type: "string", maxLength: 200 },
        description: { type: "string", maxLength: 4000 },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
      },
      ["companyId", "title"],
    ),
    async run(db, _auth, args) {
      const companyId = id(args.companyId);
      const title = typeof args.title === "string" ? args.title.slice(0, 200) : "";
      if (companyId === null || title === "") throw new Error("companyId and title are required");
      const company = await db.company.findUnique({ where: { id: companyId } });
      if (company === null) throw new Error("Company not found");
      const task = await db.task.create({
        data: {
          title,
          description: typeof args.description === "string" ? args.description.slice(0, 4000) : null,
          priority: typeof args.priority === "string" ? args.priority : "MEDIUM",
          companyId,
        },
      });
      return { taskId: task.id, status: task.status };
    },
  },
  {
    name: "tasks.list",
    description: "List tasks, optionally filtered by status.",
    requiredScope: PERMISSIONS.TASK_READ,
    inputSchema: jsonSchema({ companyId: { type: "string" }, status: { type: "string" } }),
    async run(db, _auth, args) {
      const companyId = id(args.companyId);
      const status = typeof args.status === "string" ? args.status : undefined;
      const tasks = await db.task.findMany({
        where: {
          ...(companyId !== null ? { companyId } : {}),
          ...(status !== undefined ? { status } : {}),
        },
        select: { id: true, title: true, status: true, priority: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return { tasks };
    },
  },
  {
    name: "memory.search",
    description: "Search an agent's memories by query text.",
    requiredScope: PERMISSIONS.MEMORY_READ,
    inputSchema: jsonSchema({ agentId: { type: "string" }, query: { type: "string" } }, ["agentId", "query"]),
    async run(db, _auth, args) {
      const agentId = id(args.agentId);
      const query = typeof args.query === "string" ? args.query : "";
      if (agentId === null || query === "") throw new Error("agentId and query are required");
      const memories = await db.agentMemory.findMany({
        where: { agentId, content: { contains: query } },
        select: { id: true, kind: true, content: true, importance: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      return { memories };
    },
  },
  {
    name: "testing.get_result",
    description: "Get a test run's status and summary.",
    requiredScope: PERMISSIONS.TESTING_READ,
    inputSchema: jsonSchema({ testRunId: { type: "string" } }, ["testRunId"]),
    async run(db, _auth, args) {
      const testRunId = id(args.testRunId);
      if (testRunId === null) throw new Error("testRunId is required");
      const run = await db.testRun.findUnique({
        where: { id: testRunId },
        select: { id: true, suite: true, name: true, status: true, summary: true, durationMs: true },
      });
      return { testRun: run };
    },
  },
  {
    name: "testing.run",
    description: "Queue a test suite run in a workspace via the TestingEngine.",
    requiredScope: PERMISSIONS.TESTING_RUN,
    inputSchema: jsonSchema(
      { workspaceId: { type: "string" }, suite: { type: "string" }, name: { type: "string" } },
      ["workspaceId", "suite"],
    ),
    async run(db, _auth, args) {
      const workspaceId = id(args.workspaceId);
      const suite = typeof args.suite === "string" ? args.suite.toUpperCase() : "";
      if (workspaceId === null || suite === "") throw new Error("workspaceId and suite are required");
      const { runTestSuite } = await import("../../factory/src/testing.js");
      const result = await runTestSuite(db, {
        workspaceId,
        suite: suite as never,
        name: typeof args.name === "string" ? args.name : suite,
      });
      return { testRunId: result.id, status: result.status };
    },
  },
  {
    name: "world.status",
    description: "World simulation status snapshot.",
    requiredScope: PERMISSIONS.WORLD_READ,
    inputSchema: jsonSchema({}),
    async run(db) {
      const worlds = await db.world.findMany({ select: { id: true, name: true, status: true, timeScale: true }, take: 10 });
      return { worlds };
    },
  },
  {
    name: "economy.status",
    description: "Aggregate economy status (wallet counts, latest activity only -- no balances of individuals).",
    requiredScope: PERMISSIONS.WALLET_READ,
    inputSchema: jsonSchema({}),
    async run(db) {
      const [wallets, transactions] = await Promise.all([
        db.wallet.count(),
        db.transaction.count(),
      ]);
      return { wallets, transactions };
    },
  },
  {
    name: "factory.list_runs",
    description: "List Software Factory runs (id, repo, stage).",
    requiredScope: PERMISSIONS.FACTORY_READ,
    inputSchema: jsonSchema({ companyId: { type: "string" } }),
    async run(db, _auth, args) {
      const companyId = id(args.companyId);
      const runs = await db.factoryRun.findMany({
        where: companyId !== null ? { companyId } : undefined,
        select: { id: true, repoUrl: true, currentStage: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { runs };
    },
  },
  {
    name: "factory.get_run",
    description: "Get a factory run's stage, stats and PR state (no code contents).",
    requiredScope: PERMISSIONS.FACTORY_READ,
    inputSchema: jsonSchema({ factoryRunId: { type: "string" } }, ["factoryRunId"]),
    async run(db, _auth, args) {
      const factoryRunId = id(args.factoryRunId);
      if (factoryRunId === null) throw new Error("factoryRunId is required");
      const run = await db.factoryRun.findUnique({
        where: { id: factoryRunId },
        select: { id: true, repoUrl: true, currentStage: true, status: true, stats: true, github: true, createdAt: true, updatedAt: true },
      });
      return { run };
    },
  },
  {
    name: "providers.list",
    description: "List AI providers with configured flags plus the full vendor catalog (unavailable vendors included, honestly marked).",
    requiredScope: PERMISSIONS.PROVIDER_READ,
    inputSchema: jsonSchema({}),
    async run() {
      const { getProviderRegistry, describeVendorCatalog } = await import("../../ai/src/index.js");
      const live = getProviderRegistry().list();
      return { providers: live, catalog: describeVendorCatalog() };
    },
  },
  {
    name: "models.list",
    description: "List known models with capabilities and availability (unavailable models included, honestly marked).",
    requiredScope: PERMISSIONS.PROVIDER_READ,
    inputSchema: jsonSchema({ providerId: { type: "string" }, capability: { type: "string" } }),
    async run(_db, _auth, args) {
      const { getProviderRegistry, modelRegistry } = await import("../../ai/src/index.js");
      const registry = getProviderRegistry();
      modelRegistry.refreshAvailability(
        new Set(registry.list().filter((d) => d.configured).map((d) => d.id)),
      );
      const providerId = id(args.providerId);
      const capability = typeof args.capability === "string" && args.capability !== "" ? args.capability : undefined;
      return {
        models: modelRegistry.list({
          ...(providerId !== null ? { providerId } : {}),
          ...(capability !== undefined ? { capabilities: [capability] } : {}),
        }).map((model) => ({
          providerId: model.providerId,
          modelId: model.modelId,
          displayName: model.displayName,
          capabilities: model.capabilities,
          contextWindow: model.contextWindow,
          available: model.available,
        })),
      };
    },
  },
  {
    name: "connectors.list",
    description: "List the connector marketplace (metadata only, never secrets).",
    requiredScope: PERMISSIONS.CONNECTOR_READ,
    inputSchema: jsonSchema({}),
    async run() {
      const { marketplaceCatalog } = await import("../../connectors/src/index.js");
      return {
        connectors: marketplaceCatalog().map((descriptor) => ({
          slug: descriptor.slug,
          displayName: descriptor.displayName,
          version: descriptor.version,
          category: descriptor.category,
          kind: descriptor.kind,
          auth: descriptor.auth,
          description: descriptor.description,
          actions: descriptor.actions.map((action) => action.name),
          capabilities: descriptor.capabilities,
          setupNotes: descriptor.setupNotes ?? null,
        })),
      };
    },
  },
  {
    name: "webhooks.list",
    description: "List webhook subscriptions (metadata only, never signing secrets).",
    requiredScope: PERMISSIONS.WEBHOOK_READ,
    inputSchema: jsonSchema({}),
    async run(db) {
      const rows = await db.webhookSubscription.findMany({
        select: { id: true, url: true, events: true, status: true, failureCount: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { subscriptions: rows };
    },
  },
  {
    name: "approvals.list",
    description: "List approval requests (pending first).",
    requiredScope: PERMISSIONS.APPROVAL_READ,
    inputSchema: jsonSchema({ status: { type: "string" } }),
    async run(db, _auth, args) {
      const status = typeof args.status === "string" && args.status !== "" ? args.status : "PENDING";
      const approvals = await db.approvalRequest.findMany({
        where: { status },
        select: { id: true, action: true, risk: true, status: true, reason: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { approvals };
    },
  },
  {
    name: "sessions.list",
    description: "List agent sessions (observability records, not model contexts).",
    requiredScope: PERMISSIONS.SESSION_READ,
    inputSchema: jsonSchema({ agentId: { type: "string" } }),
    async run(db, _auth, args) {
      const agentId = id(args.agentId);
      const sessions = await db.agentSession.findMany({
        where: agentId !== null ? { agentId } : undefined,
        select: { id: true, agentId: true, status: true, providerId: true, model: true, startedAt: true },
        orderBy: { startedAt: "desc" },
        take: 50,
      });
      return { sessions };
    },
  },
  {
    name: "workspaces.list",
    description: "List workspaces (id, name, status).",
    requiredScope: PERMISSIONS.WORKSPACE_READ,
    inputSchema: jsonSchema({}),
    async run(db) {
      const workspaces = await db.workspace.findMany({
        select: { id: true, name: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { workspaces };
    },
  },
  {
    name: "plans.list",
    description: "List plans (id, title, status).",
    requiredScope: PERMISSIONS.PLAN_READ,
    inputSchema: jsonSchema({ companyId: { type: "string" } }),
    async run(db, _auth, args) {
      const companyId = id(args.companyId);
      const plans = await db.plan.findMany({
        where: companyId !== null ? { companyId } : undefined,
        select: { id: true, title: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { plans };
    },
  },
];

// =============================================================================
// RESOURCES -- read-only, scope-checked.
// =============================================================================

export interface McpResourceDefinition {
  uriPattern: RegExp;
  description: string;
  requiredScope: string;
  read(db: DbClient, auth: ApiKeyAuthentication, match: RegExpMatchArray): Promise<unknown>;
}

export const MCP_RESOURCES: McpResourceDefinition[] = [
  {
    uriPattern: /^agent:\/\/(.+)$/,
    description: "Public profile of one agent.",
    requiredScope: PERMISSIONS.AGENT_READ,
    async read(db, _auth, match) {
      const agentId = match[1] ?? "";
      const agent = await db.agent.findUnique({
        where: { id: agentId },
        select: { id: true, name: true, roleKey: true, title: true, isActive: true },
      });
      return agent;
    },
  },
  {
    uriPattern: /^company:\/\/(.+)$/,
    description: "Public overview of one company.",
    requiredScope: PERMISSIONS.COMPANY_READ,
    async read(db, _auth, match) {
      const companyId = match[1] ?? "";
      const company = await db.company.findUnique({
        where: { id: companyId },
        select: { id: true, name: true, description: true, foundedAt: true },
      });
      return company;
    },
  },
  {
    uriPattern: /^task:\/\/(.+)$/,
    description: "Public record of one task.",
    requiredScope: PERMISSIONS.TASK_READ,
    async read(db, _auth, match) {
      const taskId = match[1] ?? "";
      const task = await db.task.findUnique({
        where: { id: taskId },
        select: { id: true, title: true, status: true, priority: true, type: true, createdAt: true },
      });
      return task;
    },
  },
  {
    uriPattern: /^test:\/\/(.+)$/,
    description: "Result record of one test run.",
    requiredScope: PERMISSIONS.TESTING_READ,
    async read(db, _auth, match) {
      const runId = match[1] ?? "";
      const run = await db.testRun.findUnique({
        where: { id: runId },
        select: { id: true, suite: true, name: true, status: true, summary: true },
      });
      return run;
    },
  },
  {
    uriPattern: /^world:\/\/status$/,
    description: "World status snapshot.",
    requiredScope: PERMISSIONS.WORLD_READ,
    async read(db) {
      const worlds = await db.world.findMany({ select: { id: true, name: true, status: true }, take: 10 });
      return { worlds };
    },
  },
  {
    uriPattern: /^factory:\/\/(.+)$/,
    description: "Stage, stats and PR state of one factory run.",
    requiredScope: PERMISSIONS.FACTORY_READ,
    async read(db, _auth, match) {
      const runId = match[1] ?? "";
      const run = await db.factoryRun.findUnique({
        where: { id: runId },
        select: { id: true, repoUrl: true, currentStage: true, status: true, stats: true, github: true },
      });
      return run;
    },
  },
  {
    uriPattern: /^approval:\/\/(.+)$/,
    description: "Public record of one approval request.",
    requiredScope: PERMISSIONS.APPROVAL_READ,
    async read(db, _auth, match) {
      const approvalId = match[1] ?? "";
      const approval = await db.approvalRequest.findUnique({
        where: { id: approvalId },
        select: { id: true, action: true, risk: true, status: true, reason: true, createdAt: true },
      });
      return approval;
    },
  },
  {
    uriPattern: /^workspace:\/\/(.+)$/,
    description: "Public record of one workspace.",
    requiredScope: PERMISSIONS.WORKSPACE_READ,
    async read(db, _auth, match) {
      const workspaceId = match[1] ?? "";
      const workspace = await db.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, status: true, createdAt: true },
      });
      return workspace;
    },
  },
  {
    uriPattern: /^plan:\/\/(.+)$/,
    description: "Public record of one plan.",
    requiredScope: PERMISSIONS.PLAN_READ,
    async read(db, _auth, match) {
      const planId = match[1] ?? "";
      const plan = await db.plan.findUnique({
        where: { id: planId },
        select: { id: true, title: true, objective: true, status: true, createdAt: true },
      });
      return plan;
    },
  },
  {
    uriPattern: /^session:\/\/(.+)$/,
    description: "Observability record of one agent session.",
    requiredScope: PERMISSIONS.SESSION_READ,
    async read(db, _auth, match) {
      const sessionId = match[1] ?? "";
      const session = await db.agentSession.findUnique({
        where: { id: sessionId },
        select: { id: true, agentId: true, status: true, providerId: true, model: true, startedAt: true },
      });
      return session;
    },
  },
];

// =============================================================================
// JSON-RPC plumbing (protocol layer, no transport).
// =============================================================================

export interface McpAuthContext {
  db: DbClient;
  /** Raw API key (`aw_...`) presented by the client. */
  apiKey: string | null;
  /** Client identification string for audit (user-agent). */
  clientName?: string | null;
}

export interface McpAuthResult {
  auth: ApiKeyAuthentication;
  audit(method: string, toolName: string | null, authorized: boolean, reason?: string): Promise<void>;
}

async function authenticateContext(ctx: McpAuthContext): Promise<McpAuthResult> {
  if (ctx.apiKey === null) throw new McpError(-32001, "Missing API key");
  const auth = await authenticateApiKey(ctx.db, ctx.apiKey);
  if (auth === null) throw new McpError(-32002, "Invalid or expired API key");
  return {
    auth,
    async audit(method, toolName, authorized, reason): Promise<void> {
      await eventBus
        .publishAndDispatch(ctx.db, {
          type: authorized ? EVENT_TYPES.MCP_REQUEST : EVENT_TYPES.MCP_DENIED,
          actor: SYSTEM_ACTOR,
          correlationId: newCorrelationId(),
          payload: {
            method,
            toolName,
            client: ctx.clientName ?? null,
            authorized,
            ...(reason !== undefined ? { reason } : {}),
          } as never,
        })
        .catch(() => undefined);
    },
  };
}

export class McpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type JsonRpcId = string | number | null;

function ok(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function err(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Handles one JSON-RPC 2.0 request frame and returns the response object. */
export async function handleMcpRequest(ctx: McpAuthContext, raw: unknown): Promise<Record<string, unknown>> {
  const request = raw as { id?: JsonRpcId; method?: unknown; params?: Record<string, unknown> };
  const rpcId = request.id ?? null;
  const method = typeof request.method === "string" ? request.method : "";

  try {
    if (method === "initialize") {
      return ok(rpcId, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }

    const gate = await authenticateContext(ctx);

    if (method === "tools/list") {
      await gate.audit(method, null, true);
      return ok(rpcId, {
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    }

    if (method === "tools/call") {
      const name = typeof request.params?.name === "string" ? request.params.name : "";
      const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        await gate.audit(method, name || null, false, "unknown tool");
        return err(rpcId, -32602, `Unknown tool '${name}'`);
      }
      if (!gate.auth.scopes.has(tool.requiredScope as never)) {
        await gate.audit(method, name, false, `missing scope ${tool.requiredScope}`);
        return err(rpcId, -32003, `API key lacks the scope required by '${name}'`);
      }
      const args =
        request.params?.arguments !== null && typeof request.params?.arguments === "object"
          ? (request.params.arguments as Record<string, unknown>)
          : {};
      const data = await tool.run(ctx.db, gate.auth, args);
      await gate.audit(method, name, true);
      return ok(rpcId, {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      });
    }

    if (method === "resources/list") {
      await gate.audit(method, null, true);
      return ok(rpcId, {
        resources: MCP_RESOURCES.map((resource) => ({
          uriTemplate: resource.uriPattern.source.replace(/\\\/(.+)\\\$/, "/{$1}"),
          description: resource.description,
        })),
      });
    }

    if (method === "resources/read") {
      const uri = typeof request.params?.uri === "string" ? request.params.uri : "";
      const resource = MCP_RESOURCES.find((candidate) => candidate.uriPattern.test(uri));
      if (resource === undefined) {
        await gate.audit(method, uri || null, false, "unknown resource");
        return err(rpcId, -32602, `Unknown resource '${uri}'`);
      }
      assertScopesAllow(gate.auth, resource.requiredScope as never);
      const match = resource.uriPattern.exec(uri) as RegExpMatchArray;
      const data = await resource.read(ctx.db, gate.auth, match);
      await gate.audit(method, uri, true);
      return ok(rpcId, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data) }] });
    }

    if (method === "ping") {
      return ok(rpcId, {});
    }

    return err(rpcId, -32601, `Unknown method '${method}'`);
  } catch (error) {
    if (error instanceof McpError) return err(rpcId, error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return err(rpcId, -32000, message.slice(0, 300));
  }
}
