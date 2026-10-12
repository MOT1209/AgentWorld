import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { createDefaultRegistry, ToolExecutor } from "../packages/tools/src/index.js";
import { PERMISSIONS } from "../packages/security/src/permissions.js";
import { CORRELATION, createTestAgent, createTestUser, unique } from "./helpers.js";

// AW-27 (third pass, 2026-10-12): the REST layer checks every company, agent,
// task, plan, workspace, conversation... id in a request against the caller's
// companies (scopeRefs). Agent tools, which also take those ids from model
// output, had no equivalent: an agent of company A could read and edit company
// B's tasks and plans, read B's conversations, escalate into B, and task.list
// showed B's tasks without any id at all. The executor now applies the same
// reference check to agent callers, and the list tools filter by the agent's
// company. Each exploit test below failed before the fix.

const executor = new ToolExecutor({ registry: createDefaultRegistry() });

/** Every tool permission an agent could hold: the boundary must not depend on missing grants. */
const ALL_PERMISSIONS = Object.values(PERMISSIONS) as string[];

function agentCtx(agentId: string, companyId: string | null) {
  return {
    agentId,
    actor: { actorType: "AGENT" as const, actorId: agentId },
    correlationId: CORRELATION,
    permissions: new Set<string>(ALL_PERMISSIONS),
    db: prisma,
    now: new Date(),
    ...(companyId !== null ? { companyId } : {}),
  };
}

async function world() {
  const owner = await createTestUser();
  const a = await prisma.company.create({ data: { name: unique("ScopeA"), ownerId: owner.id } });
  const b = await prisma.company.create({ data: { name: unique("ScopeB"), ownerId: owner.id } });
  const aPlanner = await createTestAgent({ roleKey: "PLANNER", companyId: a.id });
  const aExec = await createTestAgent({ roleKey: "EXECUTOR", companyId: a.id });
  const bPlanner = await createTestAgent({ roleKey: "PLANNER", companyId: b.id });
  const bExec = await createTestAgent({ roleKey: "EXECUTOR", companyId: b.id });
  const aTask = await prisma.task.create({ data: { title: unique("A-task"), companyId: a.id, priority: "MEDIUM" } });
  const bTask = await prisma.task.create({ data: { title: unique("B-secret-task"), companyId: b.id, priority: "MEDIUM" } });
  const aPlan = await prisma.plan.create({ data: { title: unique("A-plan"), objective: "Company A objective", companyId: a.id } });
  const bPlan = await prisma.plan.create({ data: { title: unique("B-secret-plan"), objective: "Company B objective", companyId: b.id } });
  const bConversation = await prisma.conversation.create({
    data: {
      kind: "DIRECT",
      title: "B private",
      companyId: b.id,
      messages: { create: { senderType: "USER", content: "B-secret-message", kind: "MESSAGE" } },
    },
  });
  return { a, b, aPlanner, aExec, bPlanner, bExec, aTask, bTask, aPlan, bPlan, bConversation };
}

const call = (tool: string, input: Record<string, unknown>, agent: { id: string }, companyId: string | null) =>
  executor.invoke(tool, input, agentCtx(agent.id, companyId) as never);

describe("AW-27: agent tools cannot act on another company's tasks, plans or conversations", () => {
  it("task.detail refuses a foreign task and still serves an own one", async () => {
    const w = await world();
    const foreign = await call("task.detail", { taskId: w.bTask.id }, w.aExec, w.a.id);
    expect(foreign.status).not.toBe("SUCCESS");
    expect(JSON.stringify(foreign)).not.toContain("B-secret-task");
    expect((await call("task.detail", { taskId: w.aTask.id }, w.aExec, w.a.id)).status).toBe("SUCCESS");
  });

  it("task.update refuses a foreign task and leaves it untouched", async () => {
    const w = await world();
    const foreign = await call("task.update", { taskId: w.bTask.id, priority: "LOW" }, w.aExec, w.a.id);
    expect(foreign.status).not.toBe("SUCCESS");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: w.bTask.id } })).priority).toBe("MEDIUM");
  });

  it("task.list shows an agent only its own company's tasks (and shared ones)", async () => {
    const w = await world();
    const shared = await prisma.task.create({ data: { title: unique("shared-task") } });
    const result = await call("task.list", { limit: 50 }, w.aExec, w.a.id);
    expect(result.status).toBe("SUCCESS");
    const ids = (result.data as { tasks: Array<{ taskId: string }> }).tasks.map((task) => task.taskId);
    expect(ids).toContain(w.aTask.id);
    expect(ids).toContain(shared.id);
    expect(ids).not.toContain(w.bTask.id);
  });

  it("task.list confines an agent whose call context omits the company, too", async () => {
    const w = await world();
    const result = await call("task.list", { limit: 50 }, w.aExec, null);
    const ids = (result.data as { tasks: Array<{ taskId: string }> }).tasks.map((task) => task.taskId);
    expect(ids).toContain(w.aTask.id);
    expect(ids).not.toContain(w.bTask.id);
  });

  it("plan.get and plan.update refuse a foreign plan", async () => {
    const w = await world();
    expect((await call("plan.get", { planId: w.bPlan.id }, w.aExec, w.a.id)).status).not.toBe("SUCCESS");
    const update = await call("plan.update", { planId: w.bPlan.id, title: "hijacked title here" }, w.aExec, w.a.id);
    expect(update.status).not.toBe("SUCCESS");
    expect((await prisma.plan.findUniqueOrThrow({ where: { id: w.bPlan.id } })).title).toContain("B-secret-plan");
    expect((await call("plan.get", { planId: w.aPlan.id }, w.aExec, w.a.id)).status).toBe("SUCCESS");
  });

  it("plan.list never lists another company's plans, with or without a company in the call context", async () => {
    const w = await world();
    for (const ctxCompany of [w.a.id, null]) {
      const result = await call("plan.list", { limit: 100 }, w.aExec, ctxCompany);
      expect(JSON.stringify(result.data), `ctx company ${String(ctxCompany)}`).not.toContain("B-secret-plan");
    }
    const ownList = await call("plan.list", { limit: 100 }, w.aExec, w.a.id);
    expect(JSON.stringify(ownList.data)).toContain(w.aPlan.title);
    expect((await call("plan.list", { companyId: w.b.id }, w.aExec, w.a.id)).status).not.toBe("SUCCESS");
  });

  it("message.read refuses another company's conversation", async () => {
    const w = await world();
    const result = await call("message.read", { conversationId: w.bConversation.id }, w.aExec, w.a.id);
    expect(result.status).not.toBe("SUCCESS");
    expect(JSON.stringify(result)).not.toContain("B-secret-message");
  });

  it("agent.escalate cannot name another company's agent, task or plan", async () => {
    const w = await world();
    const detail = "injected text meant for the other tenant";
    for (const input of [{ toAgentId: w.bPlanner.id }, { taskId: w.bTask.id }, { planId: w.bPlan.id }]) {
      const result = await call("agent.escalate", { category: "BLOCKED", detail, ...input }, w.aExec, w.a.id);
      expect(result.status, JSON.stringify(input)).not.toBe("SUCCESS");
    }
    expect(await prisma.escalation.count({ where: { fromAgentId: w.aExec.id } })).toBe(0);

    // Control: an escalation about its own task reaches its own planner.
    const own = await call("agent.escalate", { category: "BLOCKED", detail, taskId: w.aTask.id }, w.aExec, w.a.id);
    expect(own.status).toBe("SUCCESS");
    expect((own.data as { toAgentId: string }).toAgentId).toBe(w.aPlanner.id);
  });

  it("an agent with no company reaches only shared rows, never a company's", async () => {
    const w = await world();
    const drifter = await createTestAgent({ roleKey: "EXECUTOR", companyId: null });
    expect((await call("task.detail", { taskId: w.aTask.id }, drifter, null)).status).not.toBe("SUCCESS");
    const shared = await prisma.task.create({ data: { title: unique("shared-detail") } });
    expect((await call("task.detail", { taskId: shared.id }, drifter, null)).status).toBe("SUCCESS");
  });

  it("the social graph stays open across companies by design (documented exemption)", async () => {
    const w = await world();
    const result = await call("relationship.get", { targetAgentId: w.bExec.id }, w.aExec, w.a.id);
    // Not refused as "not found". (Today the tool is also held for human approval, a separate
    // finding: it is missing from the approval risk table.)
    expect(result.error ?? "").not.toMatch(/not found/i);
  });
});
