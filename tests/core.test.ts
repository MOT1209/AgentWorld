import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import {
  createAgent,
  getAgent,
  listAgents,
  changeAgentState,
  getAgentState,
  getStateHistory,
} from "../packages/agents/src/agent.service.js";
import {
  createConversation,
  sendMessage,
  getConversationDetail,
  parseRecipientSpec,
  resolveRecipient,
} from "../packages/agents/src/communication.service.js";
import {
  createTask,
  updateTask,
  getTaskDetail,
  addDependencies,
  areDependenciesSatisfied,
} from "../packages/tasks/src/task.service.js";
import {
  storeMemory,
  retrieveMemories,
  listMemories,
  forgetMemory,
  pruneExpiredMemories,
} from "../packages/memory/src/memory.service.js";
import { SYSTEM, CORRELATION, createTestAgent, unique } from "./helpers.js";

const agentCtx = { actor: SYSTEM, correlationId: CORRELATION };

describe("agents", () => {
  it("creates agents, transitions state, and records history", async () => {
    const agent = await createAgent(
      prisma,
      {
        name: unique("State Agent"),
        roleKey: "EXECUTOR",
        title: "Tester",
        systemPrompt: "prompt",
        providerId: "mock",
        model: "mock-1",
      },
      agentCtx,
    );
    const fetched = await getAgent(prisma, agent.id);
    expect(fetched.id).toBe(agent.id);

    await changeAgentState(prisma, { agentId: agent.id, state: "IDLE", reason: "boot" }, agentCtx);
    await changeAgentState(prisma, { agentId: agent.id, state: "WORKING", activity: "testing" }, agentCtx);
    const state = await getAgentState(prisma, agent.id);
    expect(state.state).toBe("WORKING");

    const history = await getStateHistory(prisma, agent.id, 10);
    expect(history.some((h) => h.toState === "WORKING")).toBe(true);

    const listed = await listAgents(prisma, { roleKey: "EXECUTOR" });
    expect(listed.some((a) => a.id === agent.id)).toBe(true);
  });
});

describe("communication", () => {
  it("sends human->agent messages and resolves role addressing", async () => {
    const a = await createTestAgent({ name: "Comm A", roleKey: "PLANNER" });
    const user = await prisma.user.create({
      data: {
        email: `${unique("comm")}@test.local`,
        passwordHash: "x".repeat(60),
        displayName: "Comm User",
        role: "OWNER",
      },
    });
    const conversation = await createConversation(
      prisma,
      { kind: "HUMAN_AGENT", title: "test", participantAgentIds: [a.id] },
      { actor: SYSTEM, correlationId: CORRELATION, userId: user.id },
    );
    const sent = await sendMessage(
      prisma,
      { conversationId: conversation.id, content: "hello agent", senderType: "HUMAN", senderUserId: user.id },
      { actor: SYSTEM, correlationId: CORRELATION, userId: user.id },
    );
    expect(sent.message.content).toBe("hello agent");
    expect(sent.notifyAgentId).toBe(a.id);

    const detail = await getConversationDetail(prisma, conversation.id);
    expect(detail.messages.length).toBeGreaterThan(0);

    const spec = parseRecipientSpec("PLANNER");
    expect(spec).toEqual({ kind: "ROLE", roleKey: "PLANNER" });
    const resolved = await resolveRecipient(prisma, spec);
    expect(resolved.some((r) => r.id === a.id)).toBe(true);
  });
});

describe("tasks", () => {
  it("creates, assigns, and completes tasks; rejects illegal transitions", async () => {
    const a = await createTestAgent({ name: "Task Worker" });
    const task = await createTask(
      prisma,
      { title: unique("Do work item"), assigneeAgentId: a.id },
      { actor: SYSTEM, agentId: a.id },
    );
    expect(["ASSIGNED", "PENDING"]).toContain(task.status);

    const running = await updateTask(prisma, task.id, { status: "RUNNING" }, { actor: SYSTEM, agentId: a.id });
    expect(running.status).toBe("RUNNING");

    const done = await updateTask(
      prisma,
      task.id,
      { status: "COMPLETED", result: "finished" },
      { actor: SYSTEM, agentId: a.id },
    );
    expect(done.status).toBe("COMPLETED");

    await expect(
      updateTask(prisma, task.id, { status: "RUNNING" }, { actor: SYSTEM, agentId: a.id }),
    ).rejects.toThrow();

    const detail = await getTaskDetail(prisma, task.id);
    expect(detail.task.id).toBe(task.id);
    expect(detail.allowedTransitions).toEqual([]);
  });

  it("rejects dependency cycles and blocks start on unmet dependencies", async () => {
    const a = await createTestAgent({ name: "Dep Worker" });
    const first = await createTask(prisma, { title: unique("First step") }, { actor: SYSTEM });
    const second = await createTask(prisma, { title: unique("Second step") }, { actor: SYSTEM });

    await addDependencies(prisma, second.id, [first.id], { actor: SYSTEM });
    expect(await areDependenciesSatisfied(prisma, second.id)).toBe(false);

    await expect(addDependencies(prisma, first.id, [second.id], { actor: SYSTEM })).rejects.toThrow();

    await updateTask(prisma, first.id, { status: "ASSIGNED", assigneeAgentId: a.id } as never, { actor: SYSTEM });
    await updateTask(prisma, first.id, { status: "RUNNING" }, { actor: SYSTEM, agentId: a.id });
    await updateTask(prisma, first.id, { status: "COMPLETED", result: "ok" }, { actor: SYSTEM, agentId: a.id });
    expect(await areDependenciesSatisfied(prisma, second.id)).toBe(true);
  });
});

describe("memory", () => {
  it("stores, ranks, expires, and isolates memories per agent", async () => {
    const a = await createTestAgent({ name: "Memory A" });
    const b = await createTestAgent({ name: "Memory B" });

    await storeMemory(
      prisma,
      { agentId: a.id, kind: "FACT", content: "market prices are high", importance: 9 },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    await storeMemory(
      prisma,
      { agentId: a.id, kind: "SHORT_TERM", content: "buy bread soon", importance: 3 },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    await storeMemory(
      prisma,
      { agentId: b.id, kind: "FACT", content: "other agent secret", importance: 10 },
      { actor: SYSTEM, correlationId: CORRELATION },
    );

    const results = await retrieveMemories(prisma, { agentId: a.id, query: "market", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.memory.content).toContain("market");
    expect(results.every((r) => r.memory.agentId === a.id)).toBe(true);

    const listed = await listMemories(prisma, { agentId: a.id });
    expect(listed.length).toBe(2);

    const expired = await storeMemory(
      prisma,
      { agentId: a.id, kind: "SHORT_TERM", content: "stale note", importance: 5, expiresAt: new Date(Date.now() - 1000) },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    const pruned = await pruneExpiredMemories(prisma, new Date());
    expect(pruned).toBeGreaterThanOrEqual(1);

    const one = await storeMemory(
      prisma,
      { agentId: a.id, kind: "FACT", content: "to forget", importance: 5 },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    await forgetMemory(prisma, one.id, { actor: SYSTEM, correlationId: CORRELATION });
    const after = await listMemories(prisma, { agentId: a.id });
    expect(after.some((m) => m.id === one.id)).toBe(false);
    expect(after.some((m) => m.id === expired.id)).toBe(false);
  });
});
