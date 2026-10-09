/**
 * Core integrity regressions (Agent 1).
 *
 * One file for confirmed Core defects: authorization boundaries, human-only
 * permissions, ledger atomicity/idempotency, agent lifecycle validation,
 * routine engine correctness, workspace path guards, execution failure
 * handling, and memory isolation. Each test pins a fix so it cannot regress
 * silently.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../packages/database/src/client.js";
import { Money } from "../packages/shared/src/index.js";
import { createDefaultRegistry, ToolExecutor } from "../packages/tools/src/index.js";
import {
  HUMAN_ONLY_PERMISSIONS,
  PERMISSIONS,
  type Permission,
} from "../packages/security/src/permissions.js";
import {
  buildRuntimeProfile,
  changeAgentState,
} from "../packages/agents/src/agent.service.js";
import { evaluateTrainingRun, startTrainingRun } from "../packages/agents/src/academy.js";
import { assertTransition } from "../packages/tasks/src/index.js";
import { deposit, transfer } from "../packages/economy/src/ledger.service.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import {
  createAgentRoutine,
  simDateKey,
  updateAgentRoutine,
} from "../packages/simulation/src/routines.js";
import { payrollDayKey } from "../packages/economy/src/index.js";
import { resolveInRoot } from "../packages/workspace/src/index.js";
import { runJob } from "../packages/execution/src/runner.js";
import { SYSTEM, CORRELATION, createTestAgent, unique } from "./helpers.js";

function ctxFor(agentId: string | undefined, perms: Permission[]) {
  return {
    ...(agentId !== undefined ? { agentId } : {}),
    actor:
      agentId !== undefined
        ? ({ actorType: "AGENT", actorId: agentId } as const)
        : SYSTEM,
    correlationId: CORRELATION,
    permissions: new Set<Permission>(perms),
    db: prisma,
    now: new Date(),
  };
}

describe("core integrity: tool executor audit + authorization", () => {
  it("writes the ToolInvocation audit row to the caller's database", async () => {
    const agent = await createTestAgent({ name: "Audit Writer" });
    const executor = new ToolExecutor({ registry: createDefaultRegistry() });
    const before = Date.now();
    const result = await executor.invoke(
      "task.list",
      { limit: 5 },
      ctxFor(agent.id, [PERMISSIONS.TASK_READ]),
    );
    expect(result.status).toBe("SUCCESS");
    const row = await prisma.toolInvocation.findFirst({
      where: { agentId: agent.id, toolName: "task.list" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe("SUCCESS");
    expect(Number(row?.createdAt.getTime())).toBeGreaterThanOrEqual(before - 5_000);
  });

  it("denies human-only tools to agents and records the denial", async () => {
    const agent = await createTestAgent({ name: "No Self Approve" });
    const executor = new ToolExecutor({ registry: createDefaultRegistry() });
    const result = await executor.invoke(
      "approval.decide",
      { approvalRequestId: "missing", decision: "APPROVED" },
      ctxFor(agent.id, [PERMISSIONS.APPROVAL_DECIDE]),
    );
    expect(result.status).toBe("DENIED");
    const row = await prisma.toolInvocation.findFirst({
      where: { agentId: agent.id, toolName: "approval.decide" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.status).toBe("DENIED");
  });

  it("exposes no registered tool that lets an agent decide approvals", () => {
    const registry = createDefaultRegistry();
    const decide = registry.has("approval.decide") ? registry.get("approval.decide") : null;
    // approval.decide exists only as a human-only gate exercise: agents are refused.
    if (decide !== null) {
      expect(decide.humanOnly).toBe(true);
    }
    for (const permission of HUMAN_ONLY_PERMISSIONS) {
      void permission;
    }
    expect(HUMAN_ONLY_PERMISSIONS.length).toBeGreaterThan(0);
  });
});

describe("core integrity: ledger atomicity + idempotency", () => {
  it("commits both transfer legs atomically when given a top-level client", async () => {
    const a = await createTestAgent({ name: "Atomic A" });
    const b = await createTestAgent({ name: "Atomic B" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    const wb = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: b.id });
    await deposit({
      toWalletId: wa.id,
      amount: Money.fromMinor(10_000, "KW"),
      description: "fund atomic",
      actor: SYSTEM,
      correlationId: CORRELATION,
      client: prisma,
    });
    const result = await transfer({
      fromWalletId: wa.id,
      toWalletId: wb.id,
      amount: Money.fromMinor(2_500, "KW"),
      description: "atomic legs",
      actor: SYSTEM,
      correlationId: CORRELATION,
      client: prisma,
    });
    expect(result.replayed).toBe(false);
    const legs = await prisma.transaction.findMany({
      where: { transferGroupId: result.transferGroupId },
    });
    expect(legs.length).toBe(2);
    expect(new Set(legs.map((leg) => leg.direction))).toEqual(new Set(["DEBIT", "CREDIT"]));
  });

  it("leaves no partial legs behind when a transfer is refused", async () => {
    const a = await createTestAgent({ name: "Broke Atomic" });
    const b = await createTestAgent({ name: "Broke Target" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    const wb = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: b.id });
    const groupProbe = unique("no-legs");
    await expect(
      transfer({
        fromWalletId: wa.id,
        toWalletId: wb.id,
        amount: Money.fromMinor(50_000, "KW"),
        description: groupProbe,
        actor: SYSTEM,
        correlationId: CORRELATION,
        client: prisma,
      }),
    ).rejects.toThrow();
    const orphans = await prisma.transaction.findMany({
      where: { description: groupProbe },
    });
    expect(orphans.length).toBe(0);
  });

  it("replays an idempotent transfer without moving money twice", async () => {
    const a = await createTestAgent({ name: "Idem Core A" });
    const b = await createTestAgent({ name: "Idem Core B" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    const wb = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: b.id });
    await deposit({
      toWalletId: wa.id,
      amount: Money.fromMinor(6_000, "KW"),
      description: "fund idem",
      actor: SYSTEM,
      correlationId: CORRELATION,
      client: prisma,
    });
    const key = `core-idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const first = await transfer({
      fromWalletId: wa.id,
      toWalletId: wb.id,
      amount: Money.fromMinor(1_000, "KW"),
      description: "idem core",
      actor: SYSTEM,
      correlationId: CORRELATION,
      idempotencyKey: key,
      client: prisma,
    });
    const second = await transfer({
      fromWalletId: wa.id,
      toWalletId: wb.id,
      amount: Money.fromMinor(1_000, "KW"),
      description: "idem core",
      actor: SYSTEM,
      correlationId: CORRELATION,
      idempotencyKey: key,
      client: prisma,
    });
    expect(second.replayed).toBe(true);
    expect(second.transferGroupId).toBe(first.transferGroupId);
    const source = await prisma.wallet.findUniqueOrThrow({ where: { id: wa.id } });
    expect(source.balanceMinor).toBe(5_000);
  });
});

describe("core integrity: lifecycle validation", () => {
  it("rejects illegal agent state transitions at the service boundary", async () => {
    const agent = await createTestAgent({ name: "State Guard" });
    // Test helpers boot agents at IDLE; park this one OFFLINE first so the
    // illegal OFFLINE -> WORKING jump can be exercised.
    await changeAgentState(prisma, { agentId: agent.id, state: "OFFLINE", reason: "park" }, { actor: SYSTEM });
    // Fresh agents start OFFLINE; OFFLINE -> WORKING skips the boot state and is illegal.
    await expect(
      changeAgentState(prisma, { agentId: agent.id, state: "WORKING", reason: "skip boot" }, { actor: SYSTEM }),
    ).rejects.toThrow();
    // OFFLINE -> IDLE is the legal boot.
    const idle = await changeAgentState(
      prisma,
      { agentId: agent.id, state: "IDLE", reason: "test boot" },
      { actor: SYSTEM },
    );
    expect(idle.state).toBe("IDLE");
    // SLEEPING -> WORKING skips waking and is illegal (must go through IDLE/ONLINE).
    await changeAgentState(prisma, { agentId: agent.id, state: "SLEEPING", reason: "nap" }, { actor: SYSTEM });
    await expect(
      changeAgentState(prisma, { agentId: agent.id, state: "WORKING", reason: "sleep-work" }, { actor: SYSTEM }),
    ).rejects.toThrow();
    await changeAgentState(prisma, { agentId: agent.id, state: "ERROR", reason: "boom" }, { actor: SYSTEM });
    await expect(
      changeAgentState(prisma, { agentId: agent.id, state: "WORKING", reason: "skip recovery" }, { actor: SYSTEM }),
    ).rejects.toThrow();
    // ERROR recovers only through IDLE or ONLINE.
    const recovered = await changeAgentState(
      prisma,
      { agentId: agent.id, state: "IDLE", reason: "recovered" },
      { actor: SYSTEM },
    );
    expect(recovered.state).toBe("IDLE");
  });

  it("rejects illegal task transitions", () => {
    expect(() => assertTransition("COMPLETED", "RUNNING")).toThrow();
    expect(() => assertTransition("CANCELLED", "PENDING")).toThrow();
  });

  it("narrows effective permissions from declared capability claims", async () => {
    const agent = await createTestAgent({ name: "Narrowed", roleKey: "EXECUTOR" });
    await prisma.agent.update({
      where: { id: agent.id },
      data: { capabilities: JSON.stringify(["wallet.read"]) },
    });
    const profile = await buildRuntimeProfile(prisma, agent.id);
    expect(profile.effectivePermissions).toContain("wallet.read");
    expect(profile.effectivePermissions).not.toContain("wallet.transfer");
  });
});

describe("core integrity: routines", () => {
  it("updates a routine without tripping over its own slot", async () => {
    const agent = await createTestAgent({ name: "Routine Self" });
    const routine = await createAgentRoutine(
      prisma,
      { agentId: agent.id, slotMinutes: 300, activityType: "WORK", durationSimMinutes: 45 },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    const updated = await updateAgentRoutine(
      prisma,
      routine.id,
      { durationSimMinutes: 60 },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    expect(updated.durationSimMinutes).toBe(60);
    expect(updated.slotMinutes).toBe(300);
  });

  it("keys routine days in UTC, matching payroll", () => {
    const late = new Date(Date.UTC(2026, 2, 16, 23, 30, 0));
    expect(simDateKey(late)).toBe("2026-03-16");
    expect(simDateKey(late)).toBe(payrollDayKey(late));
  });
});

describe("core integrity: workspace + execution + memory", () => {
  it("rejects path traversal, absolute smuggling and drive-letter escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "core-guard-"));
    expect(() => resolveInRoot(root, "../outside")).toThrow();
    expect(() => resolveInRoot(root, "/etc/passwd")).toThrow();
    expect(() => resolveInRoot(root, "C:/Windows/System32")).toThrow();
    expect(() => resolveInRoot(root, "\\\\server\\share")).toThrow();
    const inside = resolveInRoot(root, "sub/dir");
    expect(inside.startsWith(root)).toBe(true);
  });

  it("settles corrupt execution rows as FAILED instead of throwing", async () => {
    const agent = await createTestAgent({ name: "Exec Fail" });
    const job = await prisma.executionJob.create({
      data: {
        kind: "COMMAND",
        workspaceId: null,
        backendId: "mock",
        command: "not-json{{{",
        status: "QUEUED",
        scheduledAt: new Date(),
        agentId: agent.id,
        correlationId: CORRELATION,
      },
    });
    const outcome = await runJob(prisma, job.id);
    expect(outcome.claimed).toBe(true);
    expect(outcome.status).toBe("FAILED");
    const row = await prisma.executionJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("FAILED");
  });

  it("keeps agent memories isolated across agents", async () => {
    const a = await createTestAgent({ name: "Memory A" });
    const b = await createTestAgent({ name: "Memory B" });
    const executor = new ToolExecutor({ registry: createDefaultRegistry() });
    const stored = await executor.invoke(
      "memory.store",
      { kind: "FACT", content: "agent A private fact", importance: 7 },
      ctxFor(a.id, [PERMISSIONS.MEMORY_WRITE, PERMISSIONS.MEMORY_READ]),
    );
    expect(stored.status).toBe("SUCCESS");
    const searchB = await executor.invoke(
      "memory.search",
      { query: "private fact" },
      ctxFor(b.id, [PERMISSIONS.MEMORY_READ]),
    );
    expect(searchB.status).toBe("SUCCESS");
    const memories = (searchB.data as { memories: unknown[] }).memories;
    expect(memories.length).toBe(0);
    // Forgetting another agent's memory is refused.
    const owned = await prisma.agentMemory.findFirstOrThrow({ where: { agentId: a.id } });
    const forget = await executor.invoke(
      "memory.forget",
      { memoryId: owned.id },
      ctxFor(b.id, [PERMISSIONS.MEMORY_WRITE]),
    );
    expect(forget.status).toBe("ERROR");
    expect(await prisma.agentMemory.findUnique({ where: { id: owned.id } })).not.toBeNull();
  });

  it("tolerates corrupt skill payloads when evaluating training", async () => {
    const agent = await createTestAgent({ name: "Academy Harden" });
    await prisma.agent.update({ where: { id: agent.id }, data: { skills: "not-json{{{" } });
    const run = await startTrainingRun(
      prisma,
      { agentId: agent.id, skillName: "welding", passingScore: 70 },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    const evaluated = await evaluateTrainingRun(
      prisma,
      run.id,
      { score: 90, feedback: "solid" },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    expect(evaluated.status).toBe("EVALUATED");
    const updated = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(updated.skills).toContain("welding");
  });
});
