/**
 * prompts.chat connector tests: marketplace metadata, public search/get
 * over a mocked transport, and credential handling for improve_prompt.
 *
 * The live API is never touched: every call runs through an injected
 * fetch implementation, and the key under test is random per run.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { createTestUser, createTestAgent, unique, SYSTEM } from "./helpers.js";
import { resetConfigCache } from "../packages/shared/src/index.js";
import { resetVaultKeyCache, createCredential, revokeCredential } from "../packages/vault/src/index.js";
import { callConnector, getDescriptor, marketplaceCatalog } from "../packages/connectors/src/index.js";

beforeAll(() => {
  resetConfigCache();
  resetVaultKeyCache();
});

describe("prompts.chat marketplace entry", () => {
  it("is listed with governed metadata", () => {
    expect(marketplaceCatalog().map((descriptor) => descriptor.slug)).toContain("prompts-chat");
    const descriptor = getDescriptor("prompts-chat");
    expect(descriptor.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(descriptor.category).toBe("ai");
    expect(descriptor.auth).toBe("API_KEY");
    expect(descriptor.requiredScopes).toContain("connector.use");
    expect(descriptor.actions.map((action) => action.name)).toEqual([
      "search_prompts",
      "get_prompt",
      "improve_prompt",
    ]);
  });
});

describe("prompts.chat public actions", () => {
  it("searches prompts without any credential", async () => {
    let seenUrl = "";
    let seenAuth: string | null = "unset";
    const fakeFetch: typeof fetch = async (url, init) => {
      seenUrl = String(url);
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ prompts: [{ id: "abc", title: "Code Review" }] }), { status: 200 });
    };
    const agent = await createTestAgent();
    const result = await callConnector(
      { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: fakeFetch },
      { slug: "prompts-chat", action: "search_prompts", args: { query: "code review", limit: "2" } },
    );
    expect(result.ok).toBe(true);
    expect(seenUrl).toContain("https://prompts.chat/api/prompts?");
    expect(seenUrl).toContain("perPage=2");
    expect(seenAuth).toBeNull();
    expect(result.data).toMatchObject({ prompts: [{ id: "abc" }] });
  });

  it("rejects empty queries, bad limits, and unknown types", async () => {
    const agent = await createTestAgent();
    const dry = { actor: { actorType: "AGENT", actorId: agent.id } as const, db: prisma, fetchImpl: fetch };
    await expect(
      callConnector(dry, { slug: "prompts-chat", action: "search_prompts", args: { query: "" } }),
    ).rejects.toThrow();
    await expect(
      callConnector(dry, { slug: "prompts-chat", action: "search_prompts", args: { query: "x", limit: "99" } }),
    ).rejects.toThrow();
    await expect(
      callConnector(dry, { slug: "prompts-chat", action: "search_prompts", args: { query: "x", type: "NOPE" } }),
    ).rejects.toThrow();
  });

  it("fetches one prompt by id and rejects unsafe ids", async () => {
    let seenUrl = "";
    const fakeFetch: typeof fetch = async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ id: "abc123", title: "X" }), { status: 200 });
    };
    const agent = await createTestAgent();
    const result = await callConnector(
      { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: fakeFetch },
      { slug: "prompts-chat", action: "get_prompt", args: { id: "abc123" } },
    );
    expect(result.ok).toBe(true);
    expect(seenUrl).toBe("https://prompts.chat/api/prompts/abc123");
    const dry = { actor: { actorType: "AGENT", actorId: agent.id } as const, db: prisma, fetchImpl: fakeFetch };
    await expect(
      callConnector(dry, { slug: "prompts-chat", action: "get_prompt", args: { id: "../secret" } }),
    ).rejects.toThrow();
  });
});

describe("prompts.chat improve_prompt", () => {
  it("refuses without an installed credential and touches no network", async () => {
    const agent = await createTestAgent();
    let fetched = false;
    const spyFetch: typeof fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    await expect(
      callConnector(
        { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: spyFetch },
        { slug: "prompts-chat", action: "improve_prompt", args: { prompt: "write a blog post" } },
      ),
    ).rejects.toThrow(/credential/);
    expect(fetched).toBe(false);
  });

  it("sends the vault key as X-API-Key and never leaks it", async () => {
    await createTestUser();
    const token = `pchat_${unique("tok")}`;
    const cred = await createCredential(
      prisma,
      { name: unique("pchat-cred"), scope: "CONNECTOR", refId: "prompts-chat", secret: token },
      { actor: SYSTEM },
    );
    let seenKey: string | null = null;
    let seenAuth: string | null = "unset";
    let seenBody = "";
    const fakeFetch: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      seenKey = headers.get("x-api-key");
      seenAuth = headers.get("authorization");
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ improved: "You are an expert..." }), { status: 200 });
    };
    const agent = await createTestAgent();
    const result = await callConnector(
      { actor: { actorType: "AGENT", actorId: agent.id }, db: prisma, fetchImpl: fakeFetch },
      { slug: "prompts-chat", action: "improve_prompt", args: { prompt: "write a blog post" } },
    );
    expect(result.ok).toBe(true);
    expect(seenKey).toBe(token);
    expect(seenAuth).toBeNull();
    expect(seenBody).toContain("write a blog post");
    expect(JSON.stringify(result)).not.toContain(token);
    await revokeCredential(prisma, cred.id, { actor: SYSTEM });
  });
});
