/**
 * Connector platform -- how an agent reaches an external service.
 *
 *   Agent -> ToolExecutor (connector.call) -> ConnectorAdapter -> Service
 *
 * A connector is DATA + one adapter. The marketplace catalogue declares every
 * shipped connector: what it can do, what it needs, and how it authenticates.
 * Agents never see credentials: `connector.call` resolves the credential
 * server-side via the vault and injects it into the outbound request.
 */
import type { DbClient } from "../../database/src/index.js";
import { revealCredential, findActiveCredential } from "../../vault/src/index.js";
import { conflict, getConfig, newCorrelationId, validationError, type ActorRef } from "../../shared/src/index.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import type { ConnectorKind } from "../../shared/src/index.js";

export interface ConnectorAction {
  name: string;
  description: string;
  /** JSON-schema-ish argument description shown to the model. */
  parameters: Record<string, { type: string; description?: string }>;
}

export interface ConnectorSecurityMetadata {
  /** What data the connector can touch (advisory, shown before install). */
  dataAccess: string;
  /** Whether outbound calls carry a user credential, a shared token, or nothing. */
  credentialType: "USER_OAUTH" | "SHARED_TOKEN" | "NONE";
  /** Egress posture: fixed vendor hosts vs caller-supplied URLs. */
  egress: "FIXED_HOSTS" | "CALLER_URL_VALIDATED";
}

export interface ConnectorDescriptor {
  slug: string;
  displayName: string;
  version: string;
  /** Marketplace grouping: chat | dev | data | automation | ai | infra. */
  category: string;
  provider: string;
  kind: ConnectorKind;
  description: string;
  /** Base URL used for REST/GraphQL kinds. */
  baseUrl?: string;
  auth: "API_KEY" | "OAUTH" | "NONE";
  actions: ConnectorAction[];
  /** Transport-level capabilities, e.g. ["rest:get", "rest:post"]. */
  capabilities: string[];
  /** Minimum scopes a caller needs; enforced by the connector.call tool. */
  requiredScopes: string[];
  security: ConnectorSecurityMetadata;
  /** Non-secret setup docs shown on the marketplace screen. */
  setupNotes?: string;
}

export interface ConnectorCallInput {
  slug: string;
  action: string;
  args: Record<string, unknown>;
  agentId?: string | null;
}

export interface ConnectorCallContext {
  actor: ActorRef;
  correlationId?: string;
  db: DbClient;
  /** Credential row id to use; defaults to the newest ACTIVE for the slug. */
  credentialId?: string | null;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface ConnectorCallResult {
  ok: boolean;
  status: number | null;
  data: unknown;
  durationMs: number;
  connectorId: string | null;
}

/** Outbound timeout -- a connector call never hangs the agent loop. */
const CALL_TIMEOUT_MS = 15_000;

export const MARKETPLACE: ConnectorDescriptor[] = [
  {
    slug: "github",
    displayName: "GitHub",
    version: "1.0.0",
    category: "dev",
    provider: "GitHub",
    kind: "REST",
    description: "Repositories, issues, pull requests, and checks through the official REST API.",
    baseUrl: "https://api.github.com",
    auth: "API_KEY",
    actions: [
      { name: "get_repository", description: "Fetch repository metadata.", parameters: { repo: { type: "string", description: "owner/name" } } },
      { name: "list_issues", description: "List open issues for a repository.", parameters: { repo: { type: "string" } } },
      { name: "create_issue", description: "Open an issue.", parameters: { repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } } },
      { name: "list_pull_requests", description: "List pull requests.", parameters: { repo: { type: "string" } } },
      { name: "get_file", description: "Fetch a file's contents (UTF-8).", parameters: { repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } } },
    ],
    capabilities: ["rest:get", "rest:post", "repos", "issues", "pull-requests"],
    requiredScopes: ["connector.use"],
    security: { dataAccess: "Repository metadata, issues and PRs the token can see", credentialType: "SHARED_TOKEN", egress: "FIXED_HOSTS" },
    setupNotes: "Create a fine-grained personal access token with the minimum scopes the connector needs.",
  },
  {
    slug: "slack",
    displayName: "Slack",
    version: "1.0.0",
    category: "chat",
    provider: "Slack",
    kind: "REST",
    description: "Post messages and read channel history through the Slack Web API.",
    baseUrl: "https://slack.com/api",
    auth: "API_KEY",
    actions: [
      { name: "post_message", description: "Post a message to a channel.", parameters: { channel: { type: "string" }, text: { type: "string" } } },
      { name: "list_channels", description: "List channels the token can see.", parameters: {} },
    ],
    capabilities: ["rest:get", "rest:post", "chat:write", "channels:read"],
    requiredScopes: ["connector.use"],
    security: { dataAccess: "Channel list and messages the bot token can see", credentialType: "SHARED_TOKEN", egress: "FIXED_HOSTS" },
    setupNotes: "Use a Slack app bot token (xoxb...) with chat:write and channels:read scopes only.",
  },
  {
    slug: "prompts-chat",
    displayName: "prompts.chat",
    version: "1.0.0",
    category: "ai",
    provider: "prompts.chat",
    kind: "REST",
    description: "Search, retrieve, and improve community AI prompts from the prompts.chat library (https://prompts.chat).",
    baseUrl: "https://prompts.chat",
    auth: "API_KEY",
    actions: [
      { name: "search_prompts", description: "Search public prompts by keyword with optional type/category/tag filters.", parameters: { query: { type: "string", description: "Search keywords (required)" }, limit: { type: "string", description: "Max results 1-50, default 10" }, type: { type: "string", description: "TEXT, STRUCTURED, IMAGE, VIDEO or AUDIO" }, category: { type: "string", description: "Category slug filter" }, tag: { type: "string", description: "Tag slug filter" } } },
      { name: "get_prompt", description: "Fetch one public prompt by id.", parameters: { id: { type: "string", description: "Prompt id" } } },
      { name: "improve_prompt", description: "Rewrite a rough prompt into a structured one with AI (needs an installed credential).", parameters: { prompt: { type: "string", description: "Rough prompt, max 10k chars" }, outputType: { type: "string", description: "text, image, video or sound" }, outputFormat: { type: "string", description: "text, structured_json or structured_yaml" } } },
    ],
    capabilities: ["rest:get", "rest:post", "prompts:search", "prompts:read", "prompts:improve"],
    requiredScopes: ["connector.use"],
    security: { dataAccess: "Public prompt library entries; private prompts only with an installed key", credentialType: "SHARED_TOKEN", egress: "FIXED_HOSTS" },
    setupNotes: "Search and retrieval are public. For improve_prompt, install a prompts.chat API key (pchat_...) as a CONNECTOR credential with refId 'prompts-chat'.",
  },
  {
    slug: "http",
    displayName: "Generic HTTP",
    version: "1.0.0",
    category: "automation",
    provider: "Generic",
    kind: "REST",
    description: "Call any allow-listed REST endpoint with the connector's configured base URL.",
    baseUrl: "",
    auth: "API_KEY",
    actions: [
      { name: "get", description: "GET a path relative to the base URL.", parameters: { path: { type: "string" } } },
      { name: "post", description: "POST a JSON body to a relative path.", parameters: { path: { type: "string" }, body: { type: "string" } } },
    ],
    capabilities: ["rest:get", "rest:post"],
    requiredScopes: ["connector.use"],
    security: { dataAccess: "Whatever the configured base URL serves", credentialType: "SHARED_TOKEN", egress: "CALLER_URL_VALIDATED" },
    setupNotes: "Configure the credential with { baseUrl } metadata; the token is sent as a Bearer header.",
  },
  {
    slug: "graphql",
    displayName: "Generic GraphQL",
    version: "1.0.0",
    category: "data",
    provider: "Generic",
    kind: "GRAPHQL",
    description: "Execute GraphQL operations against a configured endpoint (GitHub, Linear, Shopify, ...).",
    baseUrl: "",
    auth: "API_KEY",
    actions: [
      { name: "query", description: "POST a GraphQL query with optional variables.", parameters: { query: { type: "string", description: "GraphQL document" }, variables: { type: "string", description: "JSON object string" }, endpoint: { type: "string", description: "Absolute endpoint URL (validated)" } } },
    ],
    capabilities: ["graphql:query"],
    requiredScopes: ["connector.use"],
    security: { dataAccess: "Whatever the configured endpoint serves", credentialType: "SHARED_TOKEN", egress: "CALLER_URL_VALIDATED" },
    setupNotes: "Configure the credential with { baseUrl } metadata, or pass an absolute endpoint per call. The token is sent as a Bearer header.",
  },
  {
    slug: "webhook-out",
    displayName: "Outbound Webhook",
    version: "1.0.0",
    category: "automation",
    provider: "Generic",
    kind: "WEBHOOK",
    description: "POST a signed JSON payload to a caller-supplied HTTPS URL (CI triggers, deploy hooks, Zapier, ...).",
    auth: "NONE",
    actions: [
      { name: "post", description: "POST a JSON body to an absolute URL.", parameters: { url: { type: "string", description: "Absolute https URL" }, body: { type: "string", description: "JSON body string" } } },
    ],
    capabilities: ["webhook:post"],
    requiredScopes: ["connector.use"],
    security: { dataAccess: "Only the payload the caller supplies", credentialType: "NONE", egress: "CALLER_URL_VALIDATED" },
    setupNotes: "No credential. URLs are validated (http/https only; loopback refused in production). No secrets are ever forwarded.",
  },
  {
    slug: "cli",
    displayName: "Local CLI Bridge",
    version: "0.1.0",
    category: "infra",
    provider: "Local",
    kind: "CLI",
    description: "Run allow-listed local CLI commands inside a bound workspace. Not configured in this deployment.",
    auth: "NONE",
    actions: [
      { name: "run", description: "Run an allow-listed command (unavailable until configured).", parameters: { command: { type: "string" }, workspaceId: { type: "string" } } },
    ],
    capabilities: [],
    requiredScopes: ["connector.use", "workspace.execute"],
    security: { dataAccess: "None until an allow-list is configured by an operator", credentialType: "NONE", egress: "FIXED_HOSTS" },
    setupNotes: "Unavailable: executing local commands requires a workspace-bound allow-list approved by an operator. Calls fail loudly instead of running.",
  },
  {
    slug: "database",
    displayName: "Database Bridge",
    version: "0.1.0",
    category: "data",
    provider: "Generic",
    kind: "DATABASE",
    description: "Allow-listed read-only queries against a bound database. Not configured in this deployment.",
    auth: "API_KEY",
    actions: [
      { name: "query", description: "Run an allow-listed named query (unavailable until configured).", parameters: { name: { type: "string" }, params: { type: "string" } } },
    ],
    capabilities: [],
    requiredScopes: ["connector.use"],
    security: { dataAccess: "None until named queries are allow-listed by an operator", credentialType: "SHARED_TOKEN", egress: "FIXED_HOSTS" },
    setupNotes: "Unavailable: arbitrary SQL is never executed. An operator must allow-list named read-only queries first.",
  },
  {
    slug: "mcp-bridge",
    displayName: "External MCP Bridge",
    version: "0.1.0",
    category: "ai",
    provider: "Generic",
    kind: "MCP",
    description: "Call tools on an external MCP server. No MCP client is bundled in this deployment.",
    auth: "API_KEY",
    actions: [
      { name: "call_tool", description: "Call a tool on the external server (unavailable until configured).", parameters: { server: { type: "string" }, tool: { type: "string" }, args: { type: "string" } } },
    ],
    capabilities: [],
    requiredScopes: ["connector.use"],
    security: { dataAccess: "None until an external server binding is configured", credentialType: "SHARED_TOKEN", egress: "FIXED_HOSTS" },
    setupNotes: "Unavailable: no external MCP client is bundled. Calls fail loudly instead of reaching the network.",
  },
  {
    slug: "websocket",
    displayName: "WebSocket Feed",
    version: "0.1.0",
    category: "data",
    provider: "Generic",
    kind: "WEBSOCKET",
    description: "Subscribe to a WebSocket feed. No socket client is bundled in this deployment.",
    auth: "API_KEY",
    actions: [
      { name: "subscribe", description: "Subscribe to a channel (unavailable until configured).", parameters: { url: { type: "string" }, channel: { type: "string" } } },
    ],
    capabilities: [],
    requiredScopes: ["connector.use"],
    security: { dataAccess: "None until a feed binding is configured", credentialType: "SHARED_TOKEN", egress: "FIXED_HOSTS" },
    setupNotes: "Unavailable: use webhook subscriptions or polling through the http/graphql connectors instead.",
  },
];

export function getDescriptor(slug: string): ConnectorDescriptor {
  const descriptor = MARKETPLACE.find((candidate) => candidate.slug === slug);
  if (descriptor === undefined) {
    throw validationError(`Unknown connector '${slug}'. Available: ${MARKETPLACE.map((entry) => entry.slug).join(", ")}`);
  }
  return descriptor;
}

function assertAction(descriptor: ConnectorDescriptor, action: string): ConnectorAction {
  const found = descriptor.actions.find((candidate) => candidate.name === action);
  if (found === undefined) {
    throw validationError(`Unknown action '${action}' for connector '${descriptor.slug}'`);
  }
  return found;
}

interface ResolvedAuth {
  token: string | null;
  baseUrl: string | null;
  credentialId: string | null;
}

async function resolveAuth(ctx: ConnectorCallContext, descriptor: ConnectorDescriptor): Promise<ResolvedAuth> {
  const db = ctx.db;
  if (descriptor.auth === "NONE") return { token: null, baseUrl: descriptor.baseUrl ?? null, credentialId: null };
  const credential =
    ctx.credentialId !== undefined && ctx.credentialId !== null
      ? await db.credential.findUnique({ where: { id: ctx.credentialId } })
      : await findActiveCredential(db, "CONNECTOR", descriptor.slug);
  if (credential === null) {
    // Unauthenticated call: legitimate for public endpoints (e.g. the public
    // GitHub API) and audited like any other call. Private data still requires
    // an installed credential.
    return { token: null, baseUrl: descriptor.baseUrl ?? null, credentialId: null };
  }
  const token = await revealCredential(db, credential.id, {
    actor: ctx.actor,
    correlationId: ctx.correlationId ?? newCorrelationId(),
  });
  let baseUrl = descriptor.baseUrl ?? "";
  try {
    const metadata = JSON.parse(credential.metadata) as { baseUrl?: string };
    if (typeof metadata.baseUrl === "string" && metadata.baseUrl !== "") baseUrl = metadata.baseUrl;
  } catch {
    // keep the descriptor default
  }
  return { token, baseUrl: baseUrl || null, credentialId: credential.id };
}

/**
 * Validates a caller-supplied absolute URL. Loopback and link-local targets
 * are refused in production so a connector cannot be turned into an SSRF
 * probe against the API's own network; development allows loopback so
 * integrations can be exercised against a local receiver.
 */
function validateAbsoluteUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw validationError("URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw validationError("URL must use http or https");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "169.254.169.254" ||
    host.endsWith(".local");
  if (isLoopback && getConfig().isProduction) {
    throw validationError("URL must not target loopback or link-local addresses");
  }
  return parsed.toString();
}

function buildUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${trimmedBase}${trimmedPath}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw validationError("Connector URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw validationError("Connector URL must use http or https");
  }
  return parsed.toString();
}

async function executeAction(
  descriptor: ConnectorDescriptor,
  action: ConnectorAction,
  args: Record<string, unknown>,
  auth: ResolvedAuth,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number | null; data: unknown }> {
  const headers: Record<string, string> = { "user-agent": "AgentWorld-Connector/1.0" };
  if (auth.token !== null) headers.authorization = `Bearer ${auth.token}`;
  const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");

  if (descriptor.slug === "github") {
    const repo = str("repo");
    if (repo !== "" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw validationError("repo must be in owner/name form");
    }
    if (action.name === "get_repository") {
      return request(fetchImpl, "GET", buildUrl(auth.baseUrl ?? "https://api.github.com", `/repos/${repo}`), headers);
    }
    if (action.name === "list_issues") {
      return request(fetchImpl, "GET", buildUrl(auth.baseUrl ?? "https://api.github.com", `/repos/${repo}/issues?state=open&per_page=20`), headers);
    }
    if (action.name === "create_issue") {
      headers["content-type"] = "application/json";
      return request(fetchImpl, "POST", buildUrl(auth.baseUrl ?? "https://api.github.com", `/repos/${repo}/issues`), headers, {
        title: str("title"),
        ...(str("body") !== "" ? { body: str("body") } : {}),
      });
    }
    if (action.name === "list_pull_requests") {
      return request(fetchImpl, "GET", buildUrl(auth.baseUrl ?? "https://api.github.com", `/repos/${repo}/pulls?per_page=20`), headers);
    }
    if (action.name === "get_file") {
      const path = str("path").replace(/^\/+/, "");
      if (path === "" || path.includes("..")) throw validationError("path must be a workspace-safe relative path");
      const ref = str("ref");
      const suffix = ref !== "" ? `?ref=${encodeURIComponent(ref)}` : "";
      return request(fetchImpl, "GET", buildUrl(auth.baseUrl ?? "https://api.github.com", `/repos/${repo}/contents/${encodeURI(path)}${suffix}`), { ...headers, accept: "application/vnd.github.raw" });
    }
  }

  if (descriptor.slug === "slack") {
    if (action.name === "post_message") {
      headers["content-type"] = "application/json";
      return request(fetchImpl, "POST", buildUrl(auth.baseUrl ?? "https://slack.com/api", "/chat.postMessage"), headers, {
        channel: str("channel"),
        text: str("text"),
      });
    }
    if (action.name === "list_channels") {
      return request(fetchImpl, "GET", buildUrl(auth.baseUrl ?? "https://slack.com/api", "/conversations.list?limit=50"), headers);
    }
  }

  if (descriptor.slug === "graphql") {
    const endpoint = str("endpoint") !== "" ? str("endpoint") : (auth.baseUrl ?? "");
    if (endpoint === "") throw validationError("graphql connector needs a configured base URL or an explicit endpoint");
    const url = validateAbsoluteUrl(endpoint);
    const query = str("query");
    if (query === "" || query.length > 20_000) throw validationError("query is required (max 20k chars)");
    let variables: unknown = {};
    const rawVariables = str("variables");
    if (rawVariables !== "") {
      try {
        variables = JSON.parse(rawVariables) as unknown;
      } catch {
        throw validationError("variables must be a valid JSON object string");
      }
      if (variables === null || typeof variables !== "object" || Array.isArray(variables)) {
        throw validationError("variables must be a valid JSON object string");
      }
    }
    headers["content-type"] = "application/json";
    headers.accept = "application/json";
    return request(fetchImpl, "POST", url, headers, { query, variables });
  }

  if (descriptor.slug === "webhook-out") {
    const url = validateAbsoluteUrl(str("url"));
    const rawBody = str("body");
    if (rawBody.length > 256_000) throw validationError("body exceeds the 256kb limit");
    let body: unknown = {};
    if (rawBody !== "") {
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        throw validationError("body must be valid JSON");
      }
    }
    // Deliberately no Authorization header: this connector carries no
    // credential and must never forward one.
    return request(fetchImpl, "POST", url, { "content-type": "application/json", "user-agent": "AgentWorld-Connector/1.0" }, body);
  }

  if (descriptor.slug === "cli" || descriptor.slug === "database" || descriptor.slug === "mcp-bridge" || descriptor.slug === "websocket") {
    throw conflict(
      `Connector '${descriptor.slug}' is registered but not configured in this deployment. ` +
      `No command was executed and nothing reached the network.`,
    );
  }

  if (descriptor.slug === "prompts-chat") {
    const base = (auth.baseUrl ?? "https://prompts.chat").replace(/\/+$/, "");
    // Public actions deliberately carry no Authorization header: the library
    // search API needs none, and least privilege beats convenience.
    const publicHeaders: Record<string, string> = {
      "user-agent": "AgentWorld-Connector/1.0",
      accept: "application/json",
    };
    if (action.name === "search_prompts") {
      const query = str("query").trim();
      if (query === "" || query.length > 500) throw validationError("query is required (max 500 chars)");
      let limit = 10;
      const rawLimit = str("limit").trim();
      if (rawLimit !== "") {
        limit = Number.parseInt(rawLimit, 10);
        if (!Number.isInteger(limit)) throw validationError("limit must be an integer between 1 and 50");
      }
      if (limit < 1 || limit > 50) throw validationError("limit must be an integer between 1 and 50");
      const params = new URLSearchParams({ q: query, perPage: String(limit) });
      const promptType = str("type").trim().toUpperCase();
      if (promptType !== "") {
        if (!["TEXT", "STRUCTURED", "IMAGE", "VIDEO", "AUDIO"].includes(promptType)) {
          throw validationError("type must be TEXT, STRUCTURED, IMAGE, VIDEO or AUDIO");
        }
        params.set("type", promptType);
      }
      for (const key of ["category", "tag"] as const) {
        const value = str(key).trim();
        if (value !== "") {
          if (!/^[A-Za-z0-9_-]{1,60}$/.test(value)) {
            throw validationError(`${key} must be a slug (letters, digits, '-' or '_')`);
          }
          params.set(key, value);
        }
      }
      return request(fetchImpl, "GET", `${base}/api/prompts?${params.toString()}`, publicHeaders);
    }
    if (action.name === "get_prompt") {
      const id = str("id").trim();
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) {
        throw validationError("id must be a prompt id (letters, digits, '-' or '_')");
      }
      return request(fetchImpl, "GET", buildUrl(base, `/api/prompts/${id}`), publicHeaders);
    }
    if (action.name === "improve_prompt") {
      if (auth.token === null) {
        throw validationError("improve_prompt needs an installed prompts.chat credential (CONNECTOR / prompts-chat)");
      }
      const prompt = str("prompt");
      if (prompt === "" || prompt.length > 10_000) throw validationError("prompt is required (max 10,000 chars)");
      const outputType = str("outputType").trim() !== "" ? str("outputType").trim() : "text";
      if (!["text", "image", "video", "sound"].includes(outputType)) {
        throw validationError("outputType must be text, image, video or sound");
      }
      const outputFormat = str("outputFormat").trim() !== "" ? str("outputFormat").trim() : "text";
      if (!["text", "structured_json", "structured_yaml"].includes(outputFormat)) {
        throw validationError("outputFormat must be text, structured_json or structured_yaml");
      }
      // prompts.chat authenticates this endpoint with X-API-Key, not Bearer.
      const authed: Record<string, string> = {
        ...publicHeaders,
        "content-type": "application/json",
        "x-api-key": auth.token,
      };
      return request(fetchImpl, "POST", buildUrl(base, "/api/improve-prompt"), authed, { prompt, outputType, outputFormat });
    }
  }

  if (descriptor.slug === "http") {
    const path = str("path");
    if (path === "" || path.includes("..")) throw validationError("path is required and must not traverse");
    if (action.name === "get") {
      return request(fetchImpl, "GET", buildUrl(auth.baseUrl ?? "", path), headers);
    }
    if (action.name === "post") {
      headers["content-type"] = "application/json";
      let body: unknown = {};
      const raw = str("body");
      if (raw !== "") {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          throw validationError("body must be valid JSON");
        }
      }
      return request(fetchImpl, "POST", buildUrl(auth.baseUrl ?? "", path), headers, body);
    }
  }

  throw validationError(`Action '${action.name}' is not implemented for '${descriptor.slug}'`);
}

async function request(
  fetchImpl: typeof fetch,
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ ok: boolean; status: number | null; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    let data: unknown = text;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // keep raw text
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** The single server-side entry point behind the `connector.call` tool. */
export async function callConnector(ctx: ConnectorCallContext, input: ConnectorCallInput): Promise<ConnectorCallResult> {
  const descriptor = getDescriptor(input.slug);
  const action = assertAction(descriptor, input.action);
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const started = ctx.now?.getTime() ?? Date.now();
  const fetchImpl = ctx.fetchImpl ?? fetch;

  try {
    const auth = await resolveAuth(ctx, descriptor);
    const outcome = await executeAction(descriptor, action, input.args, auth, fetchImpl);
    const durationMs: number = (ctx.now?.getTime() ?? Date.now()) - started;
    await eventBus
      .publishAndDispatch(ctx.db, {
        type: EVENT_TYPES.CONNECTOR_CALLED,
        actor: ctx.actor,
        correlationId,
        payload: {
          connectorId: auth.credentialId ?? descriptor.slug,
          slug: descriptor.slug,
          action: action.name,
          durationMs,
          agentId: input.agentId ?? null,
        },
      })
      .catch(() => undefined);
    return { ok: outcome.ok, status: outcome.status, data: outcome.data, durationMs, connectorId: auth.credentialId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await eventBus
      .publishAndDispatch(ctx.db, {
        type: EVENT_TYPES.CONNECTOR_FAILED,
        actor: ctx.actor,
        correlationId,
        payload: {
          connectorId: descriptor.slug,
          slug: descriptor.slug,
          action: action.name,
          error: message.slice(0, 300),
          agentId: input.agentId ?? null,
        },
      })
      .catch(() => undefined);
    throw error;
  }
}

/** Marketplace listing for REST/dashboard (no secrets). */
export function marketplaceCatalog(): ConnectorDescriptor[] {
  return MARKETPLACE;
}
