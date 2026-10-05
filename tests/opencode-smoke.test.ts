/**
 * The ONE live OpenCode smoke test.
 *
 * It talks to the real CLI and therefore a real model, so it is opt-in and
 * never part of the default run:
 *
 *   OPENCODE_SMOKE=1 npx vitest run tests/opencode-smoke.test.ts
 *
 * It skips cleanly (not fails) when the binary is absent or the opt-in is not
 * set, so CI never depends on OpenCode. See docs/AGENTWORLD_PHASE_3_ARCHITECTURE.md.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../packages/shared/src/config.js";
import { prisma } from "../packages/database/src/client.js";
import { enqueueExecution, runJob } from "../packages/execution/src/index.js";
import { createWorkspace } from "../packages/workspace/src/index.js";
import { CORRELATION, SYSTEM, unique } from "./helpers.js";

function openCodeAvailable(): boolean {
  try {
    const probe = spawnSync(getConfig().execution.openCodeCommand, ["--version"], {
      timeout: 30_000,
      shell: false,
      windowsHide: true,
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

const enabled = process.env.OPENCODE_SMOKE === "1" && openCodeAvailable();

describe.skipIf(!enabled)("opencode live smoke", () => {
  it("runs a prompt inside a workspace and produces a file", async () => {
    const root = mkdtempSync(join(tmpdir(), "kw-oc-smoke-"));
    try {
      const ws = await createWorkspace(
        prisma,
        { name: unique("OpenCode Smoke"), agentId: null, type: "TEMPORARY" },
        { actor: SYSTEM, correlationId: CORRELATION },
        { root },
      );
      const job = await enqueueExecution(prisma, {
        kind: "BACKEND",
        command: JSON.stringify({ prompt: "Create a file named hello.txt containing exactly the text: hi" }),
        actor: SYSTEM,
        correlationId: CORRELATION,
        backendId: "opencode",
        workspaceId: ws.id,
        timeoutMs: 240_000,
        policyCleared: true,
      });
      const outcome = await runJob(prisma, job.id);
      expect(outcome.claimed).toBe(true);
      expect(outcome.status).toBe("COMPLETED");
      expect(existsSync(join(ws.path, "hello.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
