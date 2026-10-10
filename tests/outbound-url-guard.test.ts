import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { assertPublicUrl, isNonPublicAddress } from "../packages/shared/src/index.js";
import { callConnector } from "../packages/connectors/src/index.js";
import { createCredential, revokeCredential } from "../packages/vault/src/index.js";
import { createTestAgent, unique, SYSTEM } from "./helpers.js";

// SSRF regressions: the old guard compared hostnames to a short string list,
// so 10.x/192.168.x, 127.0.0.2, "[::1]" (URL keeps the brackets) and DNS
// names pointing inward all passed in production.

const fakeLookup = async (host: string): Promise<string[]> =>
  host === "internal.example.com" ? ["10.0.0.5"] : host === "dual.example.com" ? ["93.184.216.34", "::1"] : ["93.184.216.34"];

describe("outbound URL guard", () => {
  it("classifies private, loopback, link-local and mapped addresses", () => {
    for (const ip of [
      "127.0.0.2", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "fd00::1", "fe80::1%eth0", "64:ff9b::a00:1", "ff02::1",
    ]) {
      expect(isNonPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "93.184.216.34", "::ffff:8.8.8.8", "2606:4700::1111"]) {
      expect(isNonPublicAddress(ip), ip).toBe(false);
    }
  });

  it("refuses inward URLs, including every spelling the old list missed", async () => {
    for (const url of [
      "http://[::1]/",
      "http://127.0.0.2/",
      "http://2130706433/",
      "http://[::ffff:127.0.0.1]/",
      "http://10.0.0.8/hook",
      "http://internal.example.com/",
      "http://dual.example.com/",
      "http://metadata.google.internal/",
      "ftp://hooks.example.com/",
    ]) {
      await expect(assertPublicUrl(url, fakeLookup), url).rejects.toThrow();
    }
    await expect(assertPublicUrl("https://hooks.example.com/x", fakeLookup)).resolves.toBe("https://hooks.example.com/x");
  });
});

describe("graphql connector token scope", () => {
  it("never sends the vault token to an agent-chosen endpoint on another origin", async () => {
    const token = `gql_${unique("tok")}`;
    const cred = await createCredential(
      prisma,
      { name: unique("gql-cred"), scope: "CONNECTOR", refId: "graphql", secret: token, metadata: { baseUrl: "https://api.example.com/graphql" } },
      { actor: SYSTEM },
    );
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
    const agent = await createTestAgent();
    const ctx = { actor: { actorType: "AGENT" as const, actorId: agent.id }, db: prisma, fetchImpl: fakeFetch };
    try {
      await expect(
        callConnector(ctx, { slug: "graphql", action: "query", args: { query: "{ a }", endpoint: "https://attacker.example.net/graphql" } }),
      ).rejects.toThrow(/configured base URL origin/);
      expect(seen).toHaveLength(0);

      const sameOrigin = await callConnector(ctx, {
        slug: "graphql",
        action: "query",
        args: { query: "{ a }", endpoint: "https://api.example.com/v2/graphql" },
      });
      expect(sameOrigin.ok).toBe(true);
      expect(seen).toEqual([{ url: "https://api.example.com/v2/graphql", auth: `Bearer ${token}` }]);
    } finally {
      await revokeCredential(prisma, cred.id, { actor: SYSTEM });
    }
  });
});
