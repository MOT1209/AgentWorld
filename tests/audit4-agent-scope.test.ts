import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { createDefaultRegistry, ToolExecutor } from "../packages/tools/src/index.js";
import { PERMISSIONS } from "../packages/security/src/permissions.js";
import { CORRELATION, createTestAgent, createTestUser, unique } from "./helpers.js";

// Fourth pass (2026-10-26). Agent tools that still reached across companies
// after AW-27:
//   AW-28  task.create accepted another company's task in dependsOn: the key
//          is not an id-shaped key, so the reference check never saw it, and
//          the link then exposed the foreign task's title and status
//   AW-29  factory.* and testing.* took factoryRunId / testRunId from model
//          output unchecked, and factory.list / testing.list listed every
//          company's runs
// Each exploit test below failed against the code as it stood before the fix.

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
  const a = await prisma.company.create({ data: { name: unique("Pass4A"), ownerId: owner.id } });
  const b = await prisma.company.create({ data: { name: unique("Pass4B"), ownerId: owner.id } });
  const aExec = await createTestAgent({ roleKey: "EXECUTOR", companyId: a.id });
  const bExec = await createTestAgent({ roleKey: "EXECUTOR", companyId: b.id });
  const aTask = await prisma.task.create({ data: { title: unique("A-task"), companyId: a.id, priority: "MEDIUM" } });
  const bTask = await prisma.task.create({ data: { title: unique("B-secret-task"), companyId: b.id, priority: "MEDIUM" } });
  const aRun = await prisma.factoryRun.create({ data: { repoUrl: `https://github.com/a/${unique("a-repo")}`, companyId: a.id } });
  const bRun = await prisma.factoryRun.create({ data: { repoUrl: `https://github.com/b/${unique("b-secret-repo")}`, companyId: b.id } });
  const aTest = await prisma.testRun.create({ data: { suite: "UNIT", adapter: "command", name: unique("A-test"), taskId: aTask.id } });
  const bTest = await prisma.testRun.create({ data: { suite: "UNIT", adapter: "command", name: unique("B-secret-test"), taskId: bTask.id } });
  return { a, b, aExec, bExec, aTask, bTask, aRun, bRun, aTest, bTest };
}

const call = (tool: string, input: Record<string, unknown>, agent: { id: string }, companyId: string | null) =>
  executor.invoke(tool, input, agentCtx(agent.id, companyId) as never);

describe("AW-28: task.create cannot depend on another company's task", () => {
  it("refuses a foreign dependency and records no link to it", async () => {
    const w = await world();
    const title = unique("Depends on a secret");
    const result = await call("task.create", { title, dependsOn: [w.bTask.id] }, w.aExec, w.a.id);
    expect(result.status).not.toBe("SUCCESS");
    expect(await prisma.taskDependency.count({ where: { dependsOnTaskId: w.bTask.id } })).toBe(0);
    expect(await prisma.task.count({ where: { title } }), "a refused task must not be left behind").toBe(0);
  });

  it("still accepts a dependency inside the agent's own company (control)", async () => {
    const w = await world();
    const result = await call("task.create", { title: "Depends on a colleague", dependsOn: [w.aTask.id] }, w.aExec, w.a.id);
    expect(result.status).toBe("SUCCESS");
    expect(await prisma.taskDependency.count({ where: { dependsOnTaskId: w.aTask.id } })).toBe(1);
  });
});

describe("AW-29: factory tools stay inside the agent's company", () => {
  it("factory.get and factory.project refuse a foreign run and still serve an own one", async () => {
    const w = await world();
    for (const tool of ["factory.get", "factory.project"]) {
      const foreign = await call(tool, { factoryRunId: w.bRun.id }, w.aExec, w.a.id);
      expect(foreign.status, tool).not.toBe("SUCCESS");
      expect(JSON.stringify(foreign), tool).not.toContain("b-secret-repo");
    }
    expect((await call("factory.get", { factoryRunId: w.aRun.id }, w.aExec, w.a.id)).status).toBe("SUCCESS");
  });

  it("factory.list never lists another company's runs, with or without a company in the call context", async () => {
    const w = await world();
    for (const ctxCompany of [w.a.id, null]) {
      const result = await call("factory.list", {}, w.aExec, ctxCompany);
      expect(result.status).toBe("SUCCESS");
      const ids = (result.data as { runs: Array<{ id: string }> }).runs.map((run) => run.id);
      expect(ids, `ctx company ${String(ctxCompany)}`).toContain(w.aRun.id);
      expect(ids, `ctx company ${String(ctxCompany)}`).not.toContain(w.bRun.id);
    }
    expect((await call("factory.list", { companyId: w.b.id }, w.aExec, w.a.id)).status).not.toBe("SUCCESS");
  });
});

describe("AW-29: testing tools stay inside the agent's company", () => {
  it("testing.get refuses a foreign run and still serves an own one", async () => {
    const w = await world();
    const foreign = await call("testing.get", { testRunId: w.bTest.id }, w.aExec, w.a.id);
    expect(foreign.status).not.toBe("SUCCESS");
    expect(JSON.stringify(foreign)).not.toContain("B-secret-test");
    expect((await call("testing.get", { testRunId: w.aTest.id }, w.aExec, w.a.id)).status).toBe("SUCCESS");
  });

  it("testing.settle cannot rewrite another company's run", async () => {
    const w = await world();
    const result = await call("testing.settle", { testRunId: w.bTest.id, executionStatus: "COMPLETED", exitCode: 0 }, w.aExec, w.a.id);
    expect(result.status).not.toBe("SUCCESS");
    expect((await prisma.testRun.findUniqueOrThrow({ where: { id: w.bTest.id } })).status).toBe("QUEUED");
  });

  it("testing.list without a filter shows only the agent's company's runs", async () => {
    const w = await world();
    const result = await call("testing.list", {}, w.aExec, w.a.id);
    expect(result.status).toBe("SUCCESS");
    const ids = (result.data as { runs: Array<{ id: string }> }).runs.map((run) => run.id);
    expect(ids).toContain(w.aTest.id);
    expect(ids).not.toContain(w.bTest.id);
  });
});
