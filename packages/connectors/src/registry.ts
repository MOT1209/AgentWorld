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
import { newCorrelationId, validationError, type ActorRef } from "../../shared/src/index.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import type { ConnectorKind } from "../../shared/src/index.js";

export interface ConnectorAction {
  name: string;
  description: string;
  /** JSON-schema-ish argument description shown to the model. */
  parameters: Record<string, { type: string; description?: string }>;
}

export interface ConnectorDescriptor {
  slug: string;
  displayName: string;
  kind: ConnectorKind;
  description: string;
  /** Base URL used for REST/GraphQL kinds. */
  baseUrl?: string;
  auth: "API_KEY" | "OAUTH" | "NONE";
  actions: ConnectorAction[];
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
    setupNotes: "Create a fine-grained personal access token with the minimum scopes the connector needs.",
  },
  {
    slug: "slack",
    displayName: "Slack",
    kind: "REST",
    description: "Post messages and read channel history through the Slack Web API.",
    baseUrl: "https://slack.com/api",
    auth: "API_KEY",
    actions: [
      { name: "post_message", description: "Post a message to a channel.", parameters: { channel: { type: "string" }, text: { type: "string" } } },
      { name: "list_channels", description: "List channels the token can see.", parameters: {} },
    ],
    setupNotes: "Use a Slack app bot token (xoxb...) with chat:write and channels:read scopes only.",
  },
  {
    slug: "http",
    displayName: "Generic HTTP",
    kind: "REST",
    description: "Call any allow-listed REST endpoint with the connector's configured base URL.",
    baseUrl: "",
    auth: "API_KEY",
    actions: [
      { name: "get", description: "GET a path relative to the base URL.", parameters: { path: { type: "string" } } },
      { name: "post", description: "POST a JSON body to a relative path.", parameters: { path: { type: "string" }, body: { type: "string" } } },
    ],
    setupNotes: "Configure the credential with { baseUrl } metadata; the token is sent as a Bearer header.",
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
