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
 *  - Every tool declares ONE zod schema. The advertised `inputSchema` is
 *    generated from it and the same schema validates `arguments` before
 *    `run` is called, so the contract a client sees is the contract enforced.
 *    Schemas are strict: unknown fields are rejected, not ignored.
 *  - Order per `tools/call`: authenticate -> tool lookup -> scope ->
 *    argument validation -> run. Nothing touches the database before all
 *    four pass. Validation is not authorization: the key's scope and the
 *    Core services' own rules still apply.
 *  - Tools that change state call the same Core services as REST (e.g.
 *    `tasks.create` -> TaskService.createTask), never Prisma directly, so the
 *    business rules, events and audit rows are identical on both paths.
 *  - Errors: protocol problems are JSON-RPC errors (-32602 bad params,
 *    -32003 scope, ...); an expected business failure (not found, invalid
 *    state, ...) is a tool result with `isError: true`; anything unexpected
 *    is logged with a correlation id and answered with a generic -32603 that
 *    carries only that id -- never stack traces, SQL, paths or secrets.
 *  - Resources are read-only URIs (agent://, company://, task://, ...) with
 *    scope-checked metadata responses.
 *  - Transport-agnostic: the HTTP route hands raw JSON-RPC frames to
 *    `handleMcpRequest` and sends back the JSON-RPC response, so stdio and
 *    HTTP transports can share one implementation.
 */
import { z } from "zod/v4";
import type { DbClient } from "../../database/src/index.js";
import { authenticateApiKey, type ApiKeyAuthentication } from "../../security/src/api-keys.js";
import { PERMISSIONS } from "../../security/src/permissions.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { createTask } from "../../tasks/src/task.service.js";
import {
  actorUser,
  isAppError,
  logger,
  newCorrelationId,
  notFound,
  SYSTEM_ACTOR,
  type ActorRef,
} from "../../shared/src/index.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "agentworld";
export const MCP_SERVER_VERSION = "1.0.0";

/** JSON-RPC / MCP error codes used by this server. */
export const MCP_ERROR = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  MISSING_KEY: -32001,
  INVALID_KEY: -32002,
  FORBIDDEN: -32003,
} as const;

/** Upper bound on the serialized `arguments` object, checked before parsing. */
export const MCP_MAX_ARGUMENT_BYTES = 64 * 1024;

const log = logger.child({ component: "mcp.server" });

/** Per-call context handed to a tool: who is acting, under which correlation id. */
export interface McpCallContext {
  /** The API key's owner, as the acting user (keys never act as SYSTEM). */
  actor: ActorRef;
  correlationId: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  requiredScope: string;
  /** JSON Schema generated from `input`; what `tools/list` advertises. */
  inputSchema: Record<string, unknown>;
  /** Validates `arguments` before `run`; the single source of the contract. */
  input: z.ZodType<Record<string, unknown>>;
  run(db: DbClient, auth: ApiKeyAuthentication, args: Record<string, unknown>, ctx: McpCallContext): Promise<unknown>;
}

/** Declares a tool from a strict zod object schema; `run` receives parsed, typed args. */
function tool<Shape extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  requiredScope: string;
  input: Shape;
  run(db: DbClient, auth: ApiKeyAuthentication, args: z.infer<z.ZodObject<Shape>>, ctx: McpCallContext): Promise<unknown>;
}): McpToolDefinition {
  const schema = z.strictObject(def.input);
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    name: def.name,
    description: def.description,
    requiredScope: def.requiredScope,
    inputSchema,
    input: schema as unknown as z.ZodType<Record<string, unknown>>,
    run: (db, auth, args, ctx) => def.run(db, auth, args as z.infer<z.ZodObject<Shape>>, ctx),
  };
}

// Shared argument shapes. Ids keep the historic 1..99 length bound; optional
// filters also accept "" (treated as absent) for clients that send blanks.
const Id = z.string().min(1).max(99);
const OptionalId = z.string().max(99).optional();
const OptionalFilter = z.string().max(40).optional();
const blankToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const TEST_SUITES = ["UNIT", "INTEGRATION", "E2E", "BROWSER", "MOBILE", "SECURITY", "PERFORMANCE"] as const;

// =============================================================================
// TOOLS -- every entry is an intentional external surface backed by Core.
// =============================================================================

export const MCP_TOOLS: McpToolDefinition[] = [
  tool({
    name: "agents.list",
    description: "List agents visible to the platform (id, name, role, status).",
    requiredScope: PERMISSIONS.AGENT_READ,
    input: {},
    async run(db) {
      const agents = await db.agent.findMany({
        where: { isActive: true },
        select: { id: true, name: true, roleKey: true, title: true, isActive: true },
        take: 100,
      });
      return { agents };
    },
  }),
  tool({
    name: "agents.get",
    description: "Get one agent's public profile.",
    requiredScope: PERMISSIONS.AGENT_READ,
    input: { agentId: Id },
    async run(db, _auth, args) {
      const agent = await db.agent.findUnique({
        where: { id: args.agentId },
        select: { id: true, name: true, roleKey: true, title: true, systemPrompt: false, isActive: true, reputation: true },
      });
      return { agent };
    },
  }),
  tool({
    name: "companies.list",
    description: "List companies (id, name).",
    requiredScope: PERMISSIONS.COMPANY_READ,
    input: {},
    async run(db) {
      const companies = await db.company.findMany({ select: { id: true, name: true, description: true }, take: 100 });
      return { companies };
    },
  }),
  tool({
    name: "projects.list",
    description: "List projects for a company.",
    requiredScope: PERMISSIONS.COMPANY_READ,
    input: { companyId: Id },
    async run(db, _auth, args) {
      const projects = await db.project.findMany({
        where: { companyId: args.companyId },
        select: { id: true, name: true, status: true },
        take: 100,
      });
      return { projects };
    },
  }),
  tool({
    name: "tasks.create",
    description: "Create a task in a company (governed by the Core task engine).",
    requiredScope: PERMISSIONS.TASK_CREATE,
    // Same limits as POST /api/v1/tasks.
    input: {
      companyId: Id,
      title: z.string().trim().min(3).max(200),
      description: z.string().max(5000).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
    },
    async run(db, auth, args, ctx) {
      const company = await db.company.findUnique({ where: { id: args.companyId }, select: { id: true } });
      if (company === null) throw notFound("Company", args.companyId);
      // Through the task service, exactly like REST: TASK_CREATED event,
      // task.create activity row, priority/type validation.
      const task = await createTask(
        db,
        {
          title: args.title,
          description: args.description ?? null,
          priority: args.priority ?? "MEDIUM",
          companyId: company.id,
          creatorUserId: auth.apiKey.userId,
          metadata: { source: "mcp", apiKeyId: auth.apiKey.id },
        },
        { actor: ctx.actor, permissions: auth.scopes, correlationId: ctx.correlationId },
      );
      return { taskId: task.id, status: task.status };
    },
  }),
  tool({
    name: "tasks.list",
    description: "List tasks, optionally filtered by status.",
    requiredScope: PERMISSIONS.TASK_READ,
    input: { companyId: OptionalId, status: OptionalFilter },
    async run(db, _auth, args) {
      const companyId = blankToUndefined(args.companyId);
      const status = blankToUndefined(args.status);
      const tasks = await db.task.findMany({
        where: {
          ...(companyId !== undefined ? { companyId } : {}),
          ...(status !== undefined ? { status } : {}),
        },
        select: { id: true, title: true, status: true, priority: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return { tasks };
    },
  }),
  tool({
    name: "memory.search",
    description: "Search an agent's memories by query text.",
    requiredScope: PERMISSIONS.MEMORY_READ,
    input: { agentId: Id, query: z.string().min(1).max(500) },
    async run(db, _auth, args) {
      const memories = await db.agentMemory.findMany({
        where: { agentId: args.agentId, content: { contains: args.query } },
        select: { id: true, kind: true, content: true, importance: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      return { memories };
    },
  }),
  tool({
    name: "testing.get_result",
    description: "Get a test run's status and summary.",
    requiredScope: PERMISSIONS.TESTING_READ,
    input: { testRunId: Id },
    async run(db, _auth, args) {
      const run = await db.testRun.findUnique({
        where: { id: args.testRunId },
        select: { id: true, suite: true, name: true, status: true, summary: true, durationMs: true },
      });
      return { testRun: run };
    },
  }),
  tool({
    name: "testing.run",
    description: "Queue a test suite run in a workspace via the TestingEngine.",
    requiredScope: PERMISSIONS.TESTING_RUN,
    // Suite is validated here; the TestingEngine (same as REST) still decides
    // which suites can run without a command and refuses the rest.
    input: { workspaceId: Id, suite: z.enum(TEST_SUITES), name: z.string().min(1).max(120).optional() },
    async run(db, _auth, args) {
      const { runTestSuite } = await import("../../factory/src/testing.js");
      const result = await runTestSuite(db, {
        workspaceId: args.workspaceId,
        suite: args.suite,
        name: args.name ?? args.suite,
      });
      return { testRunId: result.id, status: result.status };
    },
  }),
  tool({
    name: "world.status",
    description: "World simulation status snapshot.",
    requiredScope: PERMISSIONS.WORLD_READ,
    input: {},
    async run(db) {
      const worlds = await db.world.findMany({ select: { id: true, name: true, status: true, timeScale: true }, take: 10 });
      return { worlds };
    },
  }),
  tool({
    name: "economy.status",
    description: "Aggregate economy status (wallet counts, latest activity only -- no balances of individuals).",
    requiredScope: PERMISSIONS.WALLET_READ,
    input: {},
    async run(db) {
      const [wallets, transactions] = await Promise.all([
        db.wallet.count(),
        db.transaction.count(),
      ]);
      return { wallets, transactions };
    },
  }),
  tool({
    name: "factory.list_runs",
    description: "List Software Factory runs (id, repo, stage).",
    requiredScope: PERMISSIONS.FACTORY_READ,
    input: { companyId: OptionalId },
    async run(db, _auth, args) {
      const companyId = blankToUndefined(args.companyId);
      const runs = await db.factoryRun.findMany({
        where: companyId !== undefined ? { companyId } : undefined,
        select: { id: true, repoUrl: true, currentStage: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { runs };
    },
  }),
  tool({
    name: "factory.get_run",
    description: "Get a factory run's stage, stats and PR state (no code contents).",
    requiredScope: PERMISSIONS.FACTORY_READ,
    input: { factoryRunId: Id },
    async run(db, _auth, args) {
      const run = await db.factoryRun.findUnique({
        where: { id: args.factoryRunId },
        select: { id: true, repoUrl: true, currentStage: true, status: true, stats: true, github: true, createdAt: true, updatedAt: true },
      });
      return { run };
    },
  }),
  tool({
    name: "providers.list",
    description: "List AI providers with configured flags plus the full vendor catalog (unavailable vendors included, honestly marked).",
    requiredScope: PERMISSIONS.PROVIDER_READ,
    input: {},
    async run() {
      const { getProviderRegistry, describeVendorCatalog } = await import("../../ai/src/index.js");
      const live = getProviderRegistry().list();
      return { providers: live, catalog: describeVendorCatalog() };
    },
  }),
  tool({
    name: "models.list",
    description: "List known models with capabilities and availability (unavailable models included, honestly marked).",
    requiredScope: PERMISSIONS.PROVIDER_READ,
    input: { providerId: OptionalId, capability: OptionalFilter },
    async run(_db, _auth, args) {
      const { getProviderRegistry, modelRegistry } = await import("../../ai/src/index.js");
      const registry = getProviderRegistry();
      modelRegistry.refreshAvailability(
        new Set(registry.list().filter((d) => d.configured).map((d) => d.id)),
      );
      const providerId = blankToUndefined(args.providerId);
      const capability = blankToUndefined(args.capability);
      return {
        models: modelRegistry.list({
          ...(providerId !== undefined ? { providerId } : {}),
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
  }),
  tool({
    name: "connectors.list",
    description: "List the connector marketplace (metadata only, never secrets).",
    requiredScope: PERMISSIONS.CONNECTOR_READ,
    input: {},
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
  }),
  tool({
    name: "webhooks.list",
    description: "List webhook subscriptions (metadata only, never signing secrets).",
    requiredScope: PERMISSIONS.WEBHOOK_READ,
    input: {},
    async run(db) {
      const rows = await db.webhookSubscription.findMany({
        select: { id: true, url: true, events: true, status: true, failureCount: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { subscriptions: rows };
    },
  }),
  tool({
    name: "approvals.list",
    description: "List approval requests (pending first).",
    requiredScope: PERMISSIONS.APPROVAL_READ,
    input: { status: OptionalFilter },
    async run(db, _auth, args) {
      const status = blankToUndefined(args.status) ?? "PENDING";
      const approvals = await db.approvalRequest.findMany({
        where: { status },
        select: { id: true, action: true, risk: true, status: true, reason: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { approvals };
    },
  }),
  tool({
    name: "sessions.list",
    description: "List agent sessions (observability records, not model contexts).",
    requiredScope: PERMISSIONS.SESSION_READ,
    input: { agentId: OptionalId },
    async run(db, _auth, args) {
      const agentId = blankToUndefined(args.agentId);
      const sessions = await db.agentSession.findMany({
        where: agentId !== undefined ? { agentId } : undefined,
        select: { id: true, agentId: true, status: true, providerId: true, model: true, startedAt: true },
        orderBy: { startedAt: "desc" },
        take: 50,
      });
      return { sessions };
    },
  }),
  tool({
    name: "workspaces.list",
    description: "List workspaces (id, name, status).",
    requiredScope: PERMISSIONS.WORKSPACE_READ,
    input: {},
    async run(db) {
      const workspaces = await db.workspace.findMany({
        select: { id: true, name: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { workspaces };
    },
  }),
  tool({
    name: "plans.list",
    description: "List plans (id, title, status).",
    requiredScope: PERMISSIONS.PLAN_READ,
    input: { companyId: OptionalId },
    async run(db, _auth, args) {
      const companyId = blankToUndefined(args.companyId);
      const plans = await db.plan.findMany({
        where: companyId !== undefined ? { companyId } : undefined,
        select: { id: true, title: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { plans };
    },
  }),
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

async function authenticateContext(ctx: McpAuthContext, correlationId: string): Promise<McpAuthResult> {
  if (ctx.apiKey === null) throw new McpError(MCP_ERROR.MISSING_KEY, "Missing API key");
  const auth = await authenticateApiKey(ctx.db, ctx.apiKey);
  if (auth === null) throw new McpError(MCP_ERROR.INVALID_KEY, "Invalid or expired API key");
  return {
    auth,
    async audit(method, toolName, authorized, reason): Promise<void> {
      await eventBus
        .publishAndDispatch(ctx.db, {
          type: authorized ? EVENT_TYPES.MCP_REQUEST : EVENT_TYPES.MCP_DENIED,
          actor: SYSTEM_ACTOR,
          correlationId,
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
  readonly data?: Record<string, unknown>;
  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

type JsonRpcId = string | number | null;

function ok(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function err(id: JsonRpcId, code: number, message: string, data?: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** JSON-RPC ids are strings, numbers or null; anything else is not echoed back. */
function rpcIdOf(raw: unknown): JsonRpcId {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as { id?: unknown }).id;
  if (typeof value === "string") return value.slice(0, 200);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/**
 * Validates `params.arguments` against the tool's schema. Throws -32602 with
 * the schema issues (paths + messages, never the submitted values).
 */
export function validateToolArguments(definition: McpToolDefinition, raw: unknown): Record<string, unknown> {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new McpError(MCP_ERROR.INVALID_PARAMS, `Invalid arguments for '${definition.name}': arguments must be an object`);
  }
  const args = raw ?? {};
  let size = 0;
  try {
    size = JSON.stringify(args).length;
  } catch {
    throw new McpError(MCP_ERROR.INVALID_PARAMS, `Invalid arguments for '${definition.name}': not serializable`);
  }
  if (size > MCP_MAX_ARGUMENT_BYTES) {
    throw new McpError(MCP_ERROR.INVALID_PARAMS, `Invalid arguments for '${definition.name}': payload too large`);
  }
  const parsed = definition.input.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((issue) => ({
      path: issue.path.map(String).join(".").slice(0, 120) || "(root)",
      message: issue.message.slice(0, 200),
    }));
    throw new McpError(MCP_ERROR.INVALID_PARAMS, `Invalid arguments for '${definition.name}'`, { issues });
  }
  return parsed.data;
}

/** Handles one JSON-RPC 2.0 request frame and returns the response object. */
export async function handleMcpRequest(ctx: McpAuthContext, raw: unknown): Promise<Record<string, unknown>> {
  const rpcId = rpcIdOf(raw);
  const correlationId = newCorrelationId();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(rpcId, MCP_ERROR.INVALID_REQUEST, "Invalid request");
  }
  const request = raw as { method?: unknown; params?: unknown };
  const method = typeof request.method === "string" ? request.method : "";
  const params =
    request.params !== null && typeof request.params === "object" && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : undefined;

  try {
    if (method === "initialize") {
      return ok(rpcId, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }

    const gate = await authenticateContext(ctx, correlationId);

    if (method === "tools/list") {
      await gate.audit(method, null, true);
      return ok(rpcId, {
        tools: MCP_TOOLS.map((definition) => ({
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
        })),
      });
    }

    if (method === "tools/call") {
      const name = typeof params?.name === "string" ? params.name.slice(0, 120) : "";
      const definition = MCP_TOOLS.find((candidate) => candidate.name === name);
      if (definition === undefined) {
        await gate.audit(method, name || null, false, "unknown tool");
        return err(rpcId, MCP_ERROR.INVALID_PARAMS, `Unknown tool '${name}'`);
      }
      if (!gate.auth.scopes.has(definition.requiredScope as never)) {
        await gate.audit(method, name, false, `missing scope ${definition.requiredScope}`);
        return err(rpcId, MCP_ERROR.FORBIDDEN, `API key lacks the scope required by '${name}'`);
      }
      let args: Record<string, unknown>;
      try {
        args = validateToolArguments(definition, params?.arguments);
      } catch (validation) {
        await gate.audit(method, name, false, "invalid arguments");
        throw validation;
      }
      const callContext: McpCallContext = { actor: actorUser(gate.auth.apiKey.userId, `apikey:${gate.auth.apiKey.prefix}`), correlationId };
      let data: unknown;
      try {
        data = await definition.run(ctx.db, gate.auth, args, callContext);
      } catch (failure) {
        // Expected business outcome (not found, conflict, invalid state):
        // reported to the model as a tool error, per MCP. Infrastructure
        // failures fall through to the generic -32603 below.
        if (isAppError(failure) && failure.operational && failure.httpStatus < 500) {
          await gate.audit(method, name, true);
          return ok(rpcId, {
            content: [{ type: "text", text: failure.message.slice(0, 500) }],
            isError: true,
          });
        }
        throw failure;
      }
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
      const uri = typeof params?.uri === "string" ? params.uri : "";
      if (uri.length === 0 || uri.length > 300) {
        return err(rpcId, MCP_ERROR.INVALID_PARAMS, "Invalid resource uri");
      }
      const resource = MCP_RESOURCES.find((candidate) => candidate.uriPattern.test(uri));
      if (resource === undefined) {
        await gate.audit(method, uri, false, "unknown resource");
        return err(rpcId, MCP_ERROR.INVALID_PARAMS, `Unknown resource '${uri}'`);
      }
      if (!gate.auth.scopes.has(resource.requiredScope as never)) {
        await gate.audit(method, uri, false, `missing scope ${resource.requiredScope}`);
        return err(rpcId, MCP_ERROR.FORBIDDEN, "API key lacks the scope required by this resource");
      }
      const match = resource.uriPattern.exec(uri) as RegExpMatchArray;
      const data = await resource.read(ctx.db, gate.auth, match);
      await gate.audit(method, uri, true);
      return ok(rpcId, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data) }] });
    }

    if (method === "ping") {
      return ok(rpcId, {});
    }

    return err(rpcId, MCP_ERROR.METHOD_NOT_FOUND, `Unknown method '${method.slice(0, 120)}'`);
  } catch (error) {
    if (error instanceof McpError) return err(rpcId, error.code, error.message, error.data);
    // Full detail (incl. stack) goes to the server log only; the client gets
    // the correlation id to quote, nothing about queries, paths or secrets.
    log.error("MCP request failed", {
      action: "mcp.error",
      result: "ERROR",
      correlationId,
      method,
      error,
    });
    return err(rpcId, MCP_ERROR.INTERNAL, "Internal error", { correlationId });
  }
}
