import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../packages/database/src/client.js";
import { createDefaultRegistry, ToolExecutor } from "../packages/tools/src/index.js";
import { evaluateCommand, filterEnv } from "../packages/tools/src/command-policy.js";
import { terminalProcesses } from "../packages/tools/src/process-manager.js";
import { createWorkspace } from "../packages/workspace/src/index.js";
import type { Permission } from "../packages/security/src/permissions.js";
import { SYSTEM, CORRELATION, createTestAgent } from "./helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "kw-exec-"));
}

function executorWith(perms: Permission[], agentId?: string): { executor: ToolExecutor; ctx: Parameters<ToolExecutor["invoke"]>[2] } {
  const executor = new ToolExecutor({ registry: createDefaultRegistry() });
  return {
    executor,
    ctx: {
      ...(agentId !== undefined ? { agentId } : {}),
      actor: agentId !== undefined ? { actorType: "AGENT" as const, actorId: agentId } : SYSTEM,
      correlationId: CORRELATION,
      permissions: new Set(perms),
      db: prisma,
      now: new Date(),
    },
  };
}

const EXEC_PERMS: Permission[] = ["workspace.read", "workspace.write", "workspace.execute"];

async function tempWorkspace(agentId?: string): Promise<{ workspaceId: string; root: string; cleanup: () => void }> {
  const root = tempRoot();
  const workspace = await createWorkspace(
    prisma,
    { name: "Exec Bench", agentId: agentId ?? null, type: "TEMPORARY" },
    { actor: SYSTEM, correlationId: CORRELATION },
    { root },
  );
  return { workspaceId: workspace.id, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("command policy", () => {
  it("allows routine work", () => {
    expect(evaluateCommand(["git", "status"]).verdict).toBe("ALLOW");
    expect(evaluateCommand(["npm", "test"]).verdict).toBe("ALLOW");
    expect(evaluateCommand(["node", "-e", "1"]).verdict).toBe("ALLOW");
  });

  it("denies destruction without appeal", () => {
    for (const argv of [["rm", "-rf", "/"], ["mkfs", "/dev/sda"], ["shutdown", "now"], []]) {
      expect(evaluateCommand(argv).verdict).toBe("DENY");
    }
  });

  it("holds publishing for a human", () => {
    for (const argv of [["git", "push"], ["npm", "publish"], ["kubectl", "apply"], ["terraform", "apply"]]) {
      const result = evaluateCommand(argv);
      expect(result.verdict).toBe("REQUIRE_APPROVAL");
      expect(result.risk).toBe("HIGH");
    }
  });

  it("treats shell metacharacters as inert argv data", () => {
    // No shell ever runs: `; rm -rf /` is one harmless argument, and the
    // binary itself (`echo`-style payloads aside) decides what it means.
    const result = evaluateCommand(["node", "-e", "x; rm -rf /"]);
    expect(result.verdict).toBe("ALLOW");
  });

  it("lets workspaces tighten (never loosen) the built-ins", () => {
    expect(evaluateCommand(["npm", "test"], { deny: ["npm"] }).verdict).toBe("DENY");
    expect(evaluateCommand(["make", "deploy"], { approve: ["make deploy"] }).verdict).toBe("REQUIRE_APPROVAL");
    // Built-ins win over attempted loosening-by-omission: rm stays denied.
    expect(evaluateCommand(["rm", "-rf", "/"], { deny: [] }).verdict).toBe("DENY");
  });

  it("strips secrets from child environments", () => {
    process.env.KW_TEST_TOKEN_XYZ = "s3cret";
    try {
      const env = filterEnv({ CUSTOM_OK: "yes", MY_API_KEY: "nope", CUSTOM_OK2: "y" });
      expect(env.KW_TEST_TOKEN_XYZ).toBeUndefined();
      expect(env.MY_API_KEY).toBeUndefined();
      expect(env.CUSTOM_OK).toBe("yes");
      expect(env.PATH).toBeDefined();
    } finally {
      delete process.env.KW_TEST_TOKEN_XYZ;
    }
  });
});

describe("terminal execution", () => {
  it("runs, captures, and reports exit codes", async () => {
    const agent = await createTestAgent({ name: "Term Runner" });
    const bench = await tempWorkspace(agent.id);
    try {
      const { executor, ctx } = executorWith(EXEC_PERMS, agent.id);
      const ok = await executor.invoke(
        "terminal.exec",
        { workspaceId: bench.workspaceId, argv: ["node", "-e", "process.stdout.write('hi');"] },
        ctx,
      );
      expect(ok.status).toBe("SUCCESS");
      expect((ok.data as { exitCode: number; stdout: string }).exitCode).toBe(0);
      expect((ok.data as { stdout: string }).stdout).toBe("hi");

      const failing = await executor.invoke(
        "terminal.exec",
        { workspaceId: bench.workspaceId, argv: ["node", "-e", "process.exit(3)"] },
        ctx,
      );
      expect(failing.status).toBe("SUCCESS");
      expect((failing.data as { exitCode: number }).exitCode).toBe(3);
      expect(terminalProcesses.liveCount).toBe(0);
    } finally {
      bench.cleanup();
    }
  });

  it("kills runaways on timeout", async () => {
    const agent = await createTestAgent({ name: "Term Timeout" });
    const bench = await tempWorkspace(agent.id);
    try {
      const { executor, ctx } = executorWith(EXEC_PERMS, agent.id);
      const result = await executor.invoke(
        "terminal.exec",
        { workspaceId: bench.workspaceId, argv: ["node", "-e", "setInterval(() => {}, 1000)"], timeoutMs: 800 },
        ctx,
      );
      expect(result.status).toBe("SUCCESS");
      expect((result.data as { timedOut: boolean }).timedOut).toBe(true);
      expect(terminalProcesses.liveCount).toBe(0);
    } finally {
      bench.cleanup();
    }
  });

  it("caps output and refuses destruction", async () => {
    const agent = await createTestAgent({ name: "Term Caps" });
    const bench = await tempWorkspace(agent.id);
    try {
      const { executor, ctx } = executorWith(EXEC_PERMS, agent.id);
      const capped = await executor.invoke(
        "terminal.exec",
        { workspaceId: bench.workspaceId, argv: ["node", "-e", "process.stdout.write('x'.repeat(100000))"], maxBytes: 1024 },
        ctx,
      );
      expect(capped.status).toBe("SUCCESS");
      expect((capped.data as { truncated: boolean }).truncated).toBe(true);

      const denied = await executor.invoke("terminal.exec", { workspaceId: bench.workspaceId, argv: ["rm", "-rf", "/"] }, ctx);
      expect(denied.status).toBe("ERROR");

      const held = await executor.invoke("terminal.exec", { workspaceId: bench.workspaceId, argv: ["git", "push"] }, ctx);
      expect(held.status).toBe("PENDING_APPROVAL");
    } finally {
      bench.cleanup();
    }
  });

  it("kills live executions by id", async () => {
    const bench = await tempWorkspace();
    try {
      const running = terminalProcesses.exec({
        workspaceId: bench.workspaceId,
        command: ["node", "-e", "setInterval(() => {}, 1000)"],
        cwd: bench.root,
        env: {},
        timeoutMs: 60_000,
        maxBytes: 1024,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const live = terminalProcesses.liveInWorkspace(bench.workspaceId);
      expect(live.length).toBe(1);

      const { executor, ctx } = executorWith(EXEC_PERMS);
      const missing = await executor.invoke("terminal.kill", { executionId: "tex_does_not_exist" }, ctx);
      expect(missing.status).toBe("ERROR");

      const killed = await executor.invoke("terminal.kill", { executionId: live[0] as string }, ctx);
      expect(killed.status).toBe("SUCCESS");

      const result = await running;
      expect(result.exitCode !== 0 || result.signal !== null).toBe(true);
      expect(terminalProcesses.liveCount).toBe(0);
    } finally {
      bench.cleanup();
    }
  });
});

describe("filesystem tools", () => {
  it("round-trips files and blocks escapes", async () => {
    const agent = await createTestAgent({ name: "FS Agent" });
    const bench = await tempWorkspace(agent.id);
    try {
      const { executor, ctx } = executorWith(["workspace.read", "workspace.write"], agent.id);

      const written = await executor.invoke("fs.write", { workspaceId: bench.workspaceId, path: "docs/note.txt", content: "hello world" }, ctx);
      expect(written.status).toBe("SUCCESS");

      const read = await executor.invoke("fs.read", { workspaceId: bench.workspaceId, path: "docs/note.txt" }, ctx);
      expect(read.status).toBe("SUCCESS");
      expect((read.data as { content: string }).content).toBe("hello world");

      const listed = await executor.invoke("fs.list", { workspaceId: bench.workspaceId, path: "docs" }, ctx);
      expect((listed.data as { entries: Array<{ name: string }> }).entries.some((e) => e.name === "note.txt")).toBe(true);

      const searched = await executor.invoke("fs.search", { workspaceId: bench.workspaceId, query: "note" }, ctx);
      expect((searched.data as { matches: string[] }).matches.length).toBeGreaterThan(0);

      const moved = await executor.invoke("fs.move", { workspaceId: bench.workspaceId, from: "docs/note.txt", to: "note2.txt" }, ctx);
      expect(moved.status).toBe("SUCCESS");

      for (const evil of ["../escape.txt", "/etc/passwd", "C:\\Windows\\x.txt", "..\\..\\evil"]) {
        const attempt = await executor.invoke("fs.read", { workspaceId: bench.workspaceId, path: evil }, ctx);
        expect(attempt.status).toBe("ERROR");
        const writeAttempt = await executor.invoke("fs.write", { workspaceId: bench.workspaceId, path: evil, content: "x" }, ctx);
        expect(writeAttempt.status).toBe("ERROR");
      }

      const del = await executor.invoke("fs.delete", { workspaceId: bench.workspaceId, path: "note2.txt" }, ctx);
      expect(del.status).toBe("PENDING_APPROVAL");
    } finally {
      bench.cleanup();
    }
  });
});

describe("git tools", () => {
  it("inspects, branches, diffs, and commits locally (never pushes)", async () => {
    const agent = await createTestAgent({ name: "Git Agent" });
    const bench = await tempWorkspace(agent.id);
    try {
      const { executor, ctx } = executorWith(["workspace.read", "workspace.write", "workspace.execute"], agent.id);

      const init = await executor.invoke("terminal.exec", { workspaceId: bench.workspaceId, argv: ["git", "init"] }, ctx);
      expect(init.status).toBe("SUCCESS");

      await executor.invoke("fs.write", { workspaceId: bench.workspaceId, path: "README.md", content: "# bench\n" }, ctx);
      const committed = await executor.invoke("git.commit", { workspaceId: bench.workspaceId, message: "Bench commit for testing", addAll: true }, ctx);
      expect(committed.status).toBe("SUCCESS");

      const status = await executor.invoke("git.status", { workspaceId: bench.workspaceId }, ctx);
      expect(status.status).toBe("SUCCESS");
      expect(((status.data as { files: string[] }).files ?? []).length).toBe(0);

      const log = await executor.invoke("git.log", { workspaceId: bench.workspaceId, limit: 5 }, ctx);
      expect(((log.data as { commits: string[] }).commits ?? []).length).toBe(1);

      const branched = await executor.invoke("git.checkout", { workspaceId: bench.workspaceId, branch: "feature/bench", create: true }, ctx);
      expect(branched.status).toBe("SUCCESS");

      const diff = await executor.invoke("git.diff", { workspaceId: bench.workspaceId }, ctx);
      expect(diff.status).toBe("SUCCESS");
    } finally {
      bench.cleanup();
    }
  });
});
