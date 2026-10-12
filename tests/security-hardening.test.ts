/**
 * Cross-cutting hardening:
 *  - MCP: schema-enforced arguments before `run`, safe error mapping,
 *    scope-before-validation, MCP and REST share the task service.
 *  - Command runner: production refuses unsandboxed execution, no silent
 *    host fallback when Docker is unusable, secret-named env never reaches a
 *    child, concurrency cap.
 *  - REST: unexpected 500s do not leak internal error text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/api/src/app.js";
import { prisma } from "../packages/database/src/client.js";
import { hashPassword } from "../packages/security/src/password.js";
import { createApiKey } from "../packages/security/src/api-keys.js";
import { MCP_ERROR, MCP_MAX_ARGUMENT_BYTES, MCP_TOOLS, handleMcpRequest } from "../packages/mcp/src/index.js";
import { resetConfigCache } from "../packages/shared/src/index.js";
import { getCommandRunner, localRunner } from "../packages/tools/src/command-runner.js";
import { DockerRunner } from "../packages/tools/src/docker-runner.js";
import { ProcessManager } from "../packages/tools/src/process-manager.js";
import { SYSTEM, createTestUser, unique } from "./helpers.js";

const app = createApp();

async function mcpKey(scopes: string[]): Promise<{ secret: string; userId: string }> {
  const user = await createTestUser();
  const key = await createApiKey(
    prisma,
    { name: unique("hardening-key"), scopes, userId: user.id, ownerPermissions: new Set(scopes) },
    { actor: SYSTEM },
  );
  return { secret: key.secret, userId: user.id };
}

function call(secret: string, name: string, args: unknown, id: number | string = 1): Promise<Record<string, unknown>> {
  return handleMcpRequest(
    { db: prisma, apiKey: secret },
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
  );
}

function toolNamed(name: string) {
  const definition = MCP_TOOLS.find((t) => t.name === name);
  if (definition === undefined) throw new Error(`no tool ${name}`);
  return definition;
}

async function company(ownerId: string): Promise<string> {
  const row = await prisma.company.create({ data: { name: unique("Hardening Co"), ownerId } });
  return row.id;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP argument validation", () => {
  it("advertises the enforced schema (strict, required fields, enums)", () => {
    const schema = toolNamed("tasks.create").inputSchema as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(expect.arrayContaining(["companyId", "title"]));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.priority?.enum).toEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
    for (const definition of MCP_TOOLS) {
      expect((definition.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it("passes valid input to the tool", async () => {
    const { secret, userId } = await mcpKey(["task.create"]);
    const companyId = await company(userId);
    const response = await call(secret, "tasks.create", { companyId, title: "Valid MCP task", priority: "HIGH" });
    const result = response.result as { structuredContent: { taskId: string } };
    const task = await prisma.task.findUniqueOrThrow({ where: { id: result.structuredContent.taskId } });
    expect(task.priority).toBe("HIGH");
    expect(task.creatorUserId).toBe(userId);
  });

  it("rejects missing, mistyped and unknown fields before run() is called", async () => {
    const { secret, userId } = await mcpKey(["task.create"]);
    const companyId = await company(userId);
    const run = vi.spyOn(toolNamed("tasks.create"), "run");
    const before = await prisma.task.count();

    const cases: unknown[] = [
      { companyId },                                         // missing title
      { companyId, title: 12345 },                           // wrong type
      { companyId, title: "Fine title", priority: "URGENT" }, // not in enum
      { companyId, title: "ab" },                            // below REST minimum
      { companyId, title: "Fine title", creatorUserId: "x" }, // unknown field
      ["not", "an", "object"],                               // wrong shape
      "string-arguments",
    ];
    for (const args of cases) {
      const response = await call(secret, "tasks.create", args);
      expect(response.error).toMatchObject({ code: MCP_ERROR.INVALID_PARAMS });
    }
    expect(run).not.toHaveBeenCalled();
    expect(await prisma.task.count()).toBe(before);
  });

  it("reports schema issues by path without echoing submitted values", async () => {
    const { secret, userId } = await mcpKey(["task.create"]);
    const companyId = await company(userId);
    const response = await call(secret, "tasks.create", { companyId, title: "Fine title", sneaky: "SECRET-VALUE-123" });
    const error = response.error as { data: { issues: Array<{ path: string; message: string }> } };
    expect(error.data.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(response)).not.toContain("SECRET-VALUE-123");
  });

  it("survives huge and deeply nested payloads", async () => {
    const { secret } = await mcpKey(["task.create"]);
    const huge = await call(secret, "tasks.create", { companyId: "c", title: "x".repeat(MCP_MAX_ARGUMENT_BYTES + 10) });
    expect(huge.error).toMatchObject({ code: MCP_ERROR.INVALID_PARAMS });

    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 2_000; i += 1) nested = { n: nested };
    const deep = await call(secret, "tasks.create", { companyId: "c", title: "Fine title", nested });
    expect(deep.error).toMatchObject({ code: MCP_ERROR.INVALID_PARAMS });
  });

  it("checks scope before validation, so arguments cannot widen authority", async () => {
    const { secret } = await mcpKey(["task.read"]);
    const run = vi.spyOn(toolNamed("tasks.create"), "run");
    const response = await call(secret, "tasks.create", { companyId: "c", title: "Escalate", scopes: ["task.create"] });
    expect(response.error).toMatchObject({ code: MCP_ERROR.FORBIDDEN });
    expect(run).not.toHaveBeenCalled();
  });

  it("audits invalid arguments as a denial", async () => {
    const { secret } = await mcpKey(["task.create"]);
    const before = await prisma.eventLog.count({ where: { type: "MCP_DENIED" } });
    await call(secret, "tasks.create", { nope: true });
    expect(await prisma.eventLog.count({ where: { type: "MCP_DENIED" } })).toBe(before + 1);
  });

  it("rejects malformed frames with a protocol error", async () => {
    const response = await handleMcpRequest({ db: prisma, apiKey: null }, "not a frame");
    expect(response).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: MCP_ERROR.INVALID_REQUEST } });
  });
});

describe("MCP error mapping", () => {
  it("returns a generic -32603 with a correlation id for unexpected failures", async () => {
    const { secret } = await mcpKey(["world.read"]);
    vi.spyOn(toolNamed("world.status"), "run").mockRejectedValueOnce(
      new Error("SQLITE_ERROR near SELECT at /srv/agentworld/database/prod.db token=sk-live-abc123"),
    );
    const response = await call(secret, "world.status", {}, "req-7");
    expect(response.id).toBe("req-7");
    const error = response.error as { code: number; message: string; data: { correlationId: string } };
    expect(error.code).toBe(MCP_ERROR.INTERNAL);
    expect(error.message).toBe("Internal error");
    expect(error.data.correlationId).toMatch(/.+/);
    const text = JSON.stringify(response);
    for (const leak of ["SQLITE", "SELECT", "/srv", "sk-live", "stack", "at "]) {
      expect(text).not.toContain(leak);
    }
  });

  it("returns an expected business failure as an MCP tool error result", async () => {
    const { secret } = await mcpKey(["task.create"]);
    const response = await call(secret, "tasks.create", { companyId: "no-such-company", title: "Orphan task" });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ isError: true });
  });

  it("denies a resource read without scope with -32003 and audits it", async () => {
    const { secret } = await mcpKey(["task.read"]);
    const before = await prisma.eventLog.count({ where: { type: "MCP_DENIED" } });
    const response = await handleMcpRequest(
      { db: prisma, apiKey: secret },
      { jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "company://anything" } },
    );
    expect(response.error).toMatchObject({ code: MCP_ERROR.FORBIDDEN });
    expect(await prisma.eventLog.count({ where: { type: "MCP_DENIED" } })).toBe(before + 1);
  });
});

describe("MCP and REST share the task service", () => {
  async function ownerToken(): Promise<{ token: string; userId: string }> {
    const email = `${unique("parity-owner")}@test.local`.toLowerCase();
    const user = await prisma.user.create({
      data: { email, passwordHash: hashPassword("TestPassword123", 10), displayName: "Parity", role: "OWNER", isActive: true },
    });
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: "TestPassword123" });
    return { token: login.body.token as string, userId: user.id };
  }

  it("creates equivalent tasks with the same event + audit trail on both paths", async () => {
    const { token, userId } = await ownerToken();
    const companyId = await company(userId);
    const rest = await request(app)
      .post("/api/v1/tasks")
      .set({ Authorization: `Bearer ${token}` })
      .send({ companyId, title: "Parity task", priority: "LOW" });
    expect(rest.status).toBe(201);
    const restId = rest.body.data.id as string;

    const { secret } = await mcpKey(["task.create"]);
    const mcp = await call(secret, "tasks.create", { companyId, title: "Parity task", priority: "LOW" });
    const mcpId = (mcp.result as { structuredContent: { taskId: string } }).structuredContent.taskId;

    const [a, b] = await Promise.all([
      prisma.task.findUniqueOrThrow({ where: { id: restId } }),
      prisma.task.findUniqueOrThrow({ where: { id: mcpId } }),
    ]);
    for (const field of ["title", "priority", "status", "companyId", "type"] as const) {
      expect(b[field]).toBe(a[field]);
    }
    for (const id of [restId, mcpId]) {
      expect(await prisma.eventLog.count({ where: { type: "TASK_CREATED", targetId: id } })).toBe(1);
      expect(await prisma.activityLog.count({ where: { action: "task.create", targetId: id } })).toBe(1);
    }
  });

  it("applies the same input rules on both paths", async () => {
    const { token, userId } = await ownerToken();
    const companyId = await company(userId);
    const auth = { Authorization: `Bearer ${token}` };
    const { secret } = await mcpKey(["task.create"]);
    for (const bad of [{ title: "ab" }, { title: "Okay title", priority: "URGENT" }]) {
      const rest = await request(app).post("/api/v1/tasks").set(auth).send({ companyId, ...bad });
      expect(rest.status).toBe(400);
      const mcp = await call(secret, "tasks.create", { companyId, ...bad });
      expect(mcp.error).toMatchObject({ code: MCP_ERROR.INVALID_PARAMS });
    }
  });
});

describe("REST error responses", () => {
  it("does not leak internal error text in 500 responses", async () => {
    const { errorHandler } = await import("../apps/api/src/middleware/error-handler.js");
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
        return this;
      },
    };
    errorHandler(
      new Error("Invalid `prisma.task.create()` invocation in /srv/app/x.ts: Foreign key constraint"),
      { path: "/x", method: "POST", headers: {} } as never,
      res as never,
      () => undefined,
    );
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain("prisma");
    expect(sent.body).toMatchObject({ code: "INTERNAL_ERROR", message: "Internal server error" });
  });
});

describe("command runner isolation", () => {
  const touched = ["NODE_ENV", "JWT_SECRET", "SEED_OWNER_PASSWORD", "EXEC_SANDBOX", "EXEC_ALLOW_UNSANDBOXED_PRODUCTION", "EXEC_MAX_CONCURRENT"];
  const saved: Record<string, string | undefined> = {};
  function setEnv(values: Record<string, string | undefined>): void {
    for (const key of touched) if (!(key in saved)) saved[key] = process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  }
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
    resetConfigCache();
  });

  it("refuses to hand out the host runner in production without the opt-in", () => {
    setEnv({
      NODE_ENV: "production",
      JWT_SECRET: "p".repeat(48),
      SEED_OWNER_PASSWORD: "Another-Strong-Pass-1",
      EXEC_SANDBOX: "local",
      EXEC_ALLOW_UNSANDBOXED_PRODUCTION: undefined,
    });
    expect(() => getCommandRunner()).toThrow(/EXEC_SANDBOX=local/);
  });

  it("keeps the documented local default outside production", () => {
    setEnv({ NODE_ENV: "test", EXEC_SANDBOX: undefined });
    expect(getCommandRunner().backend).toBe("local");
  });

  it("never falls back to the host when Docker cannot run the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kw-nodocker-"));
    try {
      const runner = new DockerRunner({ image: "kingworld-missing-image:0", user: "10001:10001", memory: "64m", cpus: "0.5", pids: 32 });
      const result = await runner.exec({
        workspaceId: "ws",
        command: ["node", "-e", "console.log('RAN-ON-HOST')"],
        cwd: dir,
        env: {},
        timeoutMs: 20_000,
        maxBytes: 10_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("RAN-ON-HOST");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("strips secret-named variables at the runner, on both backends", async () => {
    const env = {
      PATH: process.env.PATH ?? "",
      GITHUB_TOKEN: "ghp_leak",
      DB_PASSWORD: "hunter2",
      MY_API_KEY: "k",
      SAFE_FLAG: "visible",
    };
    const result = await localRunner(new ProcessManager()).exec({
      workspaceId: "ws",
      command: [process.execPath, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"],
      cwd: process.cwd(),
      env,
      timeoutMs: 20_000,
      maxBytes: 100_000,
    });
    const keys = JSON.parse(result.stdout) as string[];
    expect(keys).toContain("SAFE_FLAG");
    for (const secret of ["GITHUB_TOKEN", "DB_PASSWORD", "MY_API_KEY"]) expect(keys).not.toContain(secret);

    const dir = mkdtempSync(join(tmpdir(), "kw-args-"));
    try {
      const args = new DockerRunner({ image: "img:1", user: "10001:10001", memory: "64m", cpus: "1", pids: 32 }).buildArgs(
        "kw-test",
        { workspaceId: "ws", command: ["true"], cwd: dir, env, timeoutMs: 1000, maxBytes: 1000 },
      );
      const joined = args.join(" ");
      expect(joined).toContain("SAFE_FLAG=visible");
      for (const secret of ["GITHUB_TOKEN", "DB_PASSWORD", "MY_API_KEY", "ghp_leak", "hunter2"]) expect(joined).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses commands over the concurrency cap and cleans up on cancel", async () => {
    setEnv({ EXEC_MAX_CONCURRENT: "1" });
    const manager = new ProcessManager();
    const runner = localRunner(manager);
    const controller = new AbortController();
    const base = { workspaceId: "ws", cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 30_000, maxBytes: 10_000 };
    const long = runner.exec({ ...base, command: [process.execPath, "-e", "setTimeout(() => {}, 20000)"], signal: controller.signal });
    await vi.waitFor(() => expect(manager.liveCount).toBe(1));

    const refused = await runner.exec({ ...base, command: [process.execPath, "-e", "console.log('second')"] });
    expect(refused.exitCode).toBeNull();
    expect(refused.stderr).toContain("EXEC_MAX_CONCURRENT");
    expect(refused.stdout).toBe("");

    controller.abort();
    const finished = await long;
    expect(finished.cancelled).toBe(true);
    expect(manager.liveCount).toBe(0);
  }, 30_000);
});
