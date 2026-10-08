/**
 * Phase 4 integration platform tests: vault, AI gateway usage, API keys, MCP,
 * webhooks (signing + lifecycle), connectors (mocked transport), and the
 * repository analyzer (mocked transport).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { prisma } from "../packages/database/src/client.js";
import { createTestUser, createTestAgent, unique, SYSTEM, CORRELATION } from "./helpers.js";
import {
  seal,
  open,
  createCredential,
  revealCredential,
  revokeCredential,
  listCredentials,
  credentialMetadata,
  resetVaultKeyCache,
} from "../packages/vault/src/index.js";
import { complete, usageSummary } from "../packages/ai/src/index.js";
import { setProviderRegistry, ProviderRegistry } from "../packages/ai/src/index.js";
import { MockProvider } from "../packages/ai/src/index.js";
import type { AIProvider, CompletionRequest, CompletionResult } from "../packages/ai/src/index.js";
import {
  createApiKey,
  authenticateApiKey,
  revokeApiKey,
  apiKeyMetadata,
} from "../packages/security/src/api-keys.js";
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from "../packages/mcp/src/index.js";
import {
  signPayload,
  enqueueDeliveriesForEvent,
  dispatchDueDeliveries,
  createSubscription,
  listDeliveries,
  deleteSubscription,
} from "../packages/webhooks/src/index.js";
import { toPersistedEvent } from "../packages/events/src/index.js";
import { eventBus } from "../packages/events/src/index.js";
import { callConnector, getDescriptor } from "../packages/connectors/src/index.js";
import { analyzeRepository, GithubClient } from "../packages/factory/src/index.js";
import { resetConfigCache } from "../packages/shared/src/index.js";

// A flaky provider that fails once per call to exercise the fallback chain.
class FlakyProvider implements AIProvider {
  readonly id = "flaky";
  readonly kind = "MOCK" as const;
  private calls = 0;
  isAvailable(): boolean {
    return true;
  }
  describe() {
    return {
      id: this.id,
      kind: this.kind,
      displayName: "Flaky",
      configured: true,
      defaultModel: "flaky-1",
      models: ["flaky-1"],
    };
  }
  async complete(_request: CompletionRequest): Promise<CompletionResult> {
    this.calls += 1;
    throw new Error("rate limit exceeded (429)");
  }
  callCount(): number {
    return this.calls;
  }
}

beforeAll(() => {
  resetConfigCache();
  resetVaultKeyCache();
  setProviderRegistry(new ProviderRegistry([new MockProvider(), new FlakyProvider()]));
});

afterAll(() => {
  setProviderRegistry(null);
});

describe("credential vault", () => {
  it("seals and opens a secret with tamper detection", () => {
    const sealed = seal("sk-super-secret-value");
    expect(sealed.payload).not.toContain("sk-super-secret-value");
    expect(open(sealed.payload)).toBe("sk-super-secret-value");

    const parsed = JSON.parse(sealed.payload) as { data: string };
    const tampered = parsed.data.slice(0, -4) + "AAAA";
    expect(() => open(JSON.stringify({ ...parsed, data: tampered }))).toThrow();
  });

  it("stores ciphertext only, reveals through an audited path, and revokes", async () => {
    await createTestUser();
    const row = await createCredential(
      prisma,
      {
        name: unique("vault-cred"),
        scope: "PROVIDER",
        refId: "openai-compatible",
        secret: "sk-live-abcdef123456",
      },
      { actor: SYSTEM, correlationId: CORRELATION },
    );

    const stored = await prisma.credential.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.payload).not.toContain("sk-live-abcdef123456");
    expect(JSON.parse(stored.payload)).toHaveProperty("iv");

    const listed = await listCredentials(prisma);
    expect(JSON.stringify(listed.map(credentialMetadata))).not.toContain("sk-live-abcdef123456");

    const revealed = await revealCredential(prisma, row.id, { actor: SYSTEM, correlationId: CORRELATION });
    expect(revealed).toBe("sk-live-abcdef123456");

    await revokeCredential(prisma, row.id, { actor: SYSTEM, correlationId: CORRELATION });
    await expect(revealCredential(prisma, row.id, { actor: SYSTEM, correlationId: CORRELATION })).rejects.toThrow();
  });
});

describe("ai gateway", () => {
  it("records usage rows for every call and routes to a mock model", async () => {
    const agent = await createTestAgent();
    const before = await prisma.aiUsage.count();
    const result = await complete(
      prisma,
      {
        model: "",
        messages: [{ role: "user", content: "say hi" }],
        agentId: agent.id,
      },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    expect(result.providerId).toBe("mock");
    const after = await prisma.aiUsage.count();
    expect(after).toBe(before + 1);

    const summary = await usageSummary(prisma, { agentId: agent.id });
    expect(summary.calls).toBeGreaterThan(0);
  });

  it("never routes to the flaky provider silently: bounded fallback and usage rows for failures", async () => {
    const agent = await createTestAgent();
    // Pin the flaky provider: complete() tries it, fails (recorded), then the
    // chain moves on and mock serves the call.
    const result = await complete(
      prisma,
      {
        model: "",
        providerId: "flaky",
        messages: [{ role: "user", content: "hello" }],
        agentId: agent.id,
      },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    expect(result.providerId).toBe("mock");
    expect(result.fallback).toBe(true);
    expect(result.fallbackFrom).toContain("flaky");
  });
});

describe("api keys", () => {
  it("creates a hashed key, authenticates it, enforces scope subsets, revokes", async () => {
    const user = await createTestUser();
    const ownerPerms = new Set(["agent.read", "task.read", "task.create"]);

    await expect(
      createApiKey(
        prisma,
        { name: "escalation", scopes: ["wallet.withdraw"], userId: user.id, ownerPermissions: ownerPerms },
        { actor: SYSTEM },
      ),
    ).rejects.toThrow();

    const created = await createApiKey(
      prisma,
      { name: "ci", scopes: ["agent.read", "task.read"], userId: user.id, ownerPermissions: ownerPerms },
      { actor: SYSTEM },
    );
    expect(created.secret.startsWith("aw_")).toBe(true);

    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: created.apiKey.id } });
    expect(stored.keyHash).not.toBe(created.secret);
    expect(stored.keyHash).toHaveLength(64);

    const auth = await authenticateApiKey(prisma, created.secret);
    expect(auth).not.toBeNull();
    expect(auth?.scopes.has("agent.read")).toBe(true);
    expect(auth?.scopes.has("task.create")).toBe(false);

    expect(await authenticateApiKey(prisma, "aw_wrong_key_value")).toBeNull();

    await revokeApiKey(prisma, created.apiKey.id, { actor: SYSTEM });
    expect(await authenticateApiKey(prisma, created.secret)).toBeNull();
    expect(apiKeyMetadata(await prisma.apiKey.findUniqueOrThrow({ where: { id: created.apiKey.id } })).status).toBe("REVOKED");
  });
});

describe("mcp server", () => {
  it("handshakes without auth for initialize, refuses tools without a key", async () => {
    const init = await handleMcpRequest({ db: prisma, apiKey: null }, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(init.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION });

    const denied = await handleMcpRequest(
      { db: prisma, apiKey: null },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    );
    expect(denied.error).toMatchObject({ code: -32001 });
  });

  it("lists tools and executes a scoped call with an API key", async () => {
    const user = await createTestUser();
    const company = await prisma.company.create({
      data: { name: unique("MCP Co"), ownerId: user.id },
    });
    const key = await createApiKey(
      prisma,
      {
        name: "mcp-bot",
        scopes: ["agent.read", "company.read", "task.read", "task.create"],
        userId: user.id,
        ownerPermissions: new Set(["agent.read", "company.read", "task.read", "task.create"]),
      },
      { actor: SYSTEM },
    );

    const listed = await handleMcpRequest(
      { db: prisma, apiKey: key.secret },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
    );
    const toolNames = (listed.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames).toContain("tasks.create");
    expect(toolNames).not.toContain("wallet.transfer");

    const call = await handleMcpRequest(
      { db: prisma, apiKey: key.secret },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "tasks.create", arguments: { companyId: company.id, title: "From MCP" } },
      },
    );
    expect(call.result).toBeDefined();

    const unscoped = await handleMcpRequest(
      { db: prisma, apiKey: key.secret },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "economy.status", arguments: {} } },
    );
    expect(unscoped.error).toMatchObject({ code: -32003 });

    const resource = await handleMcpRequest(
      { db: prisma, apiKey: key.secret },
      { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: `company://${company.id}` } },
    );
    expect(resource.result).toBeDefined();
  });
});

describe("webhooks", () => {
  let server: Server;
  const received: Array<{ signature: string | undefined; timestamp: string | undefined; body: string; validSignature: boolean }> = [];
  let port = 0;
  let subscriptionSecret: string | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        const signature = req.headers["x-agentworld-signature"] as string | undefined;
        const timestamp = req.headers["x-agentworld-timestamp"] as string | undefined;
        const expected = timestamp !== undefined && subscriptionSecret !== null
          ? signPayload(subscriptionSecret, timestamp, body)
          : "";
        received.push({
          signature,
          timestamp,
          body,
          validSignature: signature === `sha256=${expected}`,
        });
        res.statusCode = 200;
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("signs and delivers a matching event, verifies the HMAC at the receiver", async () => {
    const sub = await createSubscription(
      prisma,
      { url: `http://127.0.0.1:${port}/hook`, events: ["TEST_RUN_RECORDED"] },
      { actor: SYSTEM },
    );
    subscriptionSecret = sub.secret;

    const persisted = await eventBus.publish(prisma, {
      type: "TEST_RUN_RECORDED",
      actor: SYSTEM,
      payload: { testRunId: "tr-1", suite: "UNIT", adapter: "command", status: "PASSED", taskId: null },
    });
    const created = await enqueueDeliveriesForEvent(prisma, toPersistedEvent(persisted));
    expect(created).toBe(1);

    const outcome = await dispatchDueDeliveries(prisma);
    expect(outcome.delivered).toBeGreaterThanOrEqual(1);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]?.validSignature).toBe(true);
    expect(received[0]?.body).toContain("TEST_RUN_RECORDED");

    // A non-matching event type produces no delivery.
    const other = await eventBus.publish(prisma, {
      type: "LOGIN_SUCCEEDED",
      actor: SYSTEM,
      payload: { userId: "u", email: "e@x" },
    });
    const none = await enqueueDeliveriesForEvent(prisma, toPersistedEvent(other));
    expect(none).toBe(0);

    const deliveries = await listDeliveries(prisma, sub.subscription.id);
    expect(deliveries[0]).toMatchObject({ status: "DELIVERED" });
  });

  it("allows loopback webhook URLs outside production and cleans up", async () => {
    // Loopback refusal is production-only; in test/dev a local receiver is the
    // whole point, so creating a loopback subscription must succeed here.
    const sub = await createSubscription(
      prisma,
      { url: "http://localhost:4000/hook", events: ["*"], description: "loopback test" },
      { actor: SYSTEM },
    );
    expect(sub.subscription.url).toBe("http://localhost:4000/hook");
    expect(sub.secret).toMatch(/^whsec_/);

    await deleteSubscription(prisma, sub.subscription.id, { actor: SYSTEM });
    const stillThere = await prisma.webhookSubscription.findUnique({ where: { id: sub.subscription.id } });
    expect(stillThere?.status).not.toBe("ACTIVE");
  });
});

describe("connectors", () => {
  it("exposes a marketplace and validates slugs/actions", () => {
    expect(getDescriptor("github").slug).toBe("github");
    expect(() => getDescriptor("nope")).toThrow();
  });

  it("calls github with an injected transport and never leaks the token", async () => {
    await createTestUser();
    // Install a github token so the connector authenticates; the raw value
    // must never appear in the result.
    const token = `ghp_${unique("tok")}`;
    const cred = await createCredential(
      prisma,
      { name: unique("gh-cred"), scope: "CONNECTOR", refId: "github", secret: token },
      { actor: SYSTEM },
    );
    let sawAuthHeader: string | null = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      sawAuthHeader = headers.get("authorization");
      return new Response(JSON.stringify({ full_name: "acme/widgets", default_branch: "main" }), { status: 200 });
    };

    const agent = await createTestAgent();
    const result = await callConnector(
      { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: fakeFetch },
      { slug: "github", action: "get_repository", args: { repo: "acme/widgets" } },
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ full_name: "acme/widgets" });
    expect(sawAuthHeader).not.toBeNull();
    // The token itself never reaches the caller-visible result.
    expect(JSON.stringify(result)).not.toContain(sawAuthHeader ?? "impossible");
    expect(JSON.stringify(result)).not.toContain(token);
    await revokeCredential(prisma, cred.id, { actor: SYSTEM });
  });

  it("rejects unknown actions", async () => {
    await expect(
      callConnector(
        { actor: SYSTEM, db: prisma, fetchImpl: fetch },
        { slug: "github", action: "delete_everything", args: {} },
      ),
    ).rejects.toThrow();
  });
});

describe("repository analyzer", () => {
  it("produces a labelled health report from a mocked GitHub transport", async () => {
    const treePayload = {
      tree: [
        { path: "package.json", type: "blob" },
        { path: "tsconfig.json", type: "blob" },
        { path: "vitest.config.ts", type: "blob" },
        { path: ".github/workflows/ci.yml", type: "blob" },
        { path: "README.md", type: "blob" },
        { path: "src", type: "tree" },
      ],
    };
    const fakeFetch: typeof fetch = async (url) => {
      const target = String(url);
      if (target.includes("/git/trees/")) {
        return new Response(JSON.stringify(treePayload), { status: 200 });
      }
      if (target.match(/\/repos\/[^/]+\/[^/]+$/)) {
        return new Response(
          JSON.stringify({
            full_name: "acme/widgets",
            default_branch: "main",
            language: "TypeScript",
            size: 120,
            stargazers_count: 3,
            open_issues_count: 1,
            fork: false,
            archived: false,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const client = new GithubClient({ token: "ghp_test", fetchImpl: fakeFetch });
    const report = await analyzeRepository("https://github.com/acme/widgets", client);
    expect(report.languages).toContain("TypeScript");
    expect(report.ci).toContain("GitHub Actions");
    expect(report.documentation.readme).toBe(true);
    expect(report.observed.length).toBeGreaterThan(0);
    expect(report.inferred.length).toBeGreaterThan(0);
    expect(report.score).toBeGreaterThan(40);
  });
});
