import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCommand, filterEnv } from "../packages/tools/src/command-policy.js";
import { ProcessManager } from "../packages/tools/src/process-manager.js";
import { resolveInRoot } from "../packages/workspace/src/index.js";

// Regression suite for the policy/sandbox bypasses found in the full review.
// The command policy is defense-in-depth, NOT a sandbox: real isolation
// (container, no network, non-root) is still required before untrusted agents.

describe("command policy bypasses", () => {
  it("catches inline code behind extra flags or bundled short flags", () => {
    for (const argv of [
      ["node", "--no-warnings", "-e", "1"],
      ["node", "--require", "./x.js", "-p", "1"],
      ["python3", "-I", "-c", "import os"],
      ["python3", "-Ic", "import os"],
      ["node", "--eval=1"],
    ]) {
      expect(evaluateCommand(argv).verdict, JSON.stringify(argv)).toBe("REQUIRE_APPROVAL");
    }
    expect(evaluateCommand(["node", "script.js", "-p", "3000"]).verdict).toBe("ALLOW");
  });

  it("catches publishing verbs behind global options", () => {
    for (const argv of [
      ["git", "-C", ".", "push", "origin", "main"],
      ["git", "--no-pager", "push"],
      ["npm", "--registry", "https://x.example", "publish"],
    ]) {
      expect(evaluateCommand(argv).verdict, JSON.stringify(argv)).toBe("REQUIRE_APPROVAL");
    }
  });

  it("holds fetch-and-run, exec-capable and config-injecting commands", () => {
    for (const argv of [
      ["npx", "-y", "some-package"],
      ["npm", "exec", "--", "cowsay"],
      ["git", "clone", "https://example.com/x.git"],
      ["git", "-c", "alias.x=!sh -c id", "x"],
      ["find", ".", "-exec", "sh", "-c", "id", ";"],
      ["find", ".", "-delete"],
    ]) {
      expect(evaluateCommand(argv).verdict, JSON.stringify(argv)).toBe("REQUIRE_APPROVAL");
    }
    expect(evaluateCommand(["find", ".", "-name", "*.ts"]).verdict).toBe("ALLOW");
    expect(evaluateCommand(["git", "status"]).verdict).toBe("ALLOW");
  });
});

describe("agent-supplied environment", () => {
  it("drops loader, interpreter and PATH overrides", () => {
    const env = filterEnv({
      PATH: "./bin",
      NODE_OPTIONS: "--require ./x.js",
      LD_PRELOAD: "./x.so",
      GIT_SSH_COMMAND: "sh",
      PYTHONPATH: "./evil",
      "BAD KEY": "x",
      MY_FLAG: "ok",
    });
    expect(env.PATH).not.toBe("./bin");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env["BAD KEY"]).toBeUndefined();
    expect(env.MY_FLAG).toBe("ok");
  });
});

describe("workspace path guard", () => {
  it("rejects writes through a symlink that points outside, even for new files", () => {
    const base = mkdtempSync(join(tmpdir(), "kw-sym-"));
    const root = join(base, "ws");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(root, "link"));
      expect(() => resolveInRoot(root, "link/new.txt")).toThrow(/outside the workspace root/);
      expect(() => resolveInRoot(root, "link/sub/deeper/new.txt")).toThrow(/outside the workspace root/);
      expect(resolveInRoot(root, "ok/new.txt")).toBe(join(root, "ok", "new.txt"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects drive-letter and UNC paths on every platform", () => {
    const root = mkdtempSync(join(tmpdir(), "kw-drv-"));
    try {
      expect(() => resolveInRoot(root, "C:\\Windows\\x.txt")).toThrow();
      expect(() => resolveInRoot(root, "\\\\server\\share\\x")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("process timeout", () => {
  it.skipIf(process.platform === "win32")("kills grandchildren, not just the direct child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kw-pg-"));
    const marker = join(dir, "alive.txt");
    try {
      const pm = new ProcessManager();
      // The inner node would write the marker after 1.5s if it survived.
      const inner = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)`;
      const outer = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
      const result = await pm.exec({
        workspaceId: "w",
        command: [process.execPath, "-e", outer],
        cwd: dir,
        env: filterEnv(),
        timeoutMs: 500,
        maxBytes: 1024,
      });
      expect(result.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
