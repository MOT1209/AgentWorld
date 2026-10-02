/**
 * King World seed — idempotent development bootstrap.
 *
 * Creates, in dependency order:
 * owner user, world + city + locations, company, Ahmad (PLANNER) + Rashid (EXECUTOR),
 * departments + memberships, wallets + treasury funding, sample conversation/tasks/memories,
 * and one pending approval so the Approvals screen is never empty.
 *
 * Re-runnable: every entity is upserted by natural key.
 */
/* eslint-disable no-console */
import "dotenv/config";
import { prisma } from "../packages/database/src/client.js";
import { getConfig, Money, slugify } from "../packages/shared/src/index.js";
import { hashPassword } from "../packages/security/src/password.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { fundTreasury } from "../packages/economy/src/treasury.service.js";
import { actorSystem } from "../packages/shared/src/actor.js";
import {
  defaultPersonalityForRole,
  makeSkill,
  needsFromInitial,
  serializeSkills,
  serializeVitals,
} from "../packages/simulation/src/index.js";

const SYSTEM = actorSystem("seed");

async function main(): Promise<void> {
  const config = getConfig();
  const correlationId = `seed-${Date.now().toString(36)}`;
  const ctx = { actor: SYSTEM, correlationId, userId: undefined as string | undefined };

  // 1. Owner user
  const ownerEmail = config.seed.ownerEmail.toLowerCase();
  let owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (owner === null) {
    owner = await prisma.user.create({
      data: {
        email: ownerEmail,
        passwordHash: hashPassword(config.seed.ownerPassword, config.bcryptRounds),
        displayName: "King",
        role: "OWNER",
        isActive: true,
      },
    });
    console.log(`seed: owner ${ownerEmail} created`);
  } else {
    console.log(`seed: owner ${ownerEmail} exists`);
  }
  await ensureWallet(prisma, { ownerType: "USER", ownerId: owner.id });

  // 2. World + City
  let world = await prisma.world.findUnique({ where: { name: "King World" } });
  if (world === null) {
    world = await prisma.world.create({
      data: {
        name: "King World",
        description: "The first simulated company world",
        timeScale: config.world.timeScale,
        status: "RUNNING",
      },
    });
  } else if (world.status === "INITIALIZING" || world.status === "STOPPED") {
    // A seeded world is meant to be observable immediately.
    world = await prisma.world.update({ where: { id: world.id }, data: { status: "RUNNING" } });
    console.log("seed: world promoted to RUNNING");
  }
  let city = await prisma.city.findUnique({ where: { worldId_name: { worldId: world.id, name: "King City" } } });
  if (city === null) {
    city = await prisma.city.create({
      data: { worldId: world.id, name: "King City", description: "Capital of King World", kind: "CAPITAL" },
    });
  }

  // 3. Locations
  const locations: Array<{ name: string; kind: string; address: string | null; capacity?: number }> = [
    { name: "King AI Corporation HQ", kind: "HQ", address: "1 King Plaza", capacity: 50 },
    { name: "Ahmad Workspace", kind: "OFFICE", address: "1 King Plaza, Floor 3", capacity: 4 },
    { name: "Rashid Workspace", kind: "OFFICE", address: "1 King Plaza, Floor 2", capacity: 4 },
    { name: "Common Area", kind: "PUBLIC_SPACE", address: "1 King Plaza, Lobby", capacity: 100 },
    { name: "Central Bank", kind: "BANK", address: "2 Vault Street" },
    { name: "Central Market", kind: "MARKET", address: "3 Bazaar Road" },
  ];
  const locationIds: Record<string, string> = {};
  for (const loc of locations) {
    const existing = await prisma.location.findUnique({
      where: { cityId_name: { cityId: city.id, name: loc.name } },
    });
    const row =
      existing ??
      (await prisma.location.create({
        data: {
          cityId: city.id,
          name: loc.name,
          kind: loc.kind,
          address: loc.address,
          ...(loc.capacity !== undefined ? { capacity: loc.capacity } : {}),
        },
      }));
    locationIds[loc.name] = row.id;
  }
  const hqId = locationIds["King AI Corporation HQ"] as string;

  // 4. Company
  let company = await prisma.company.findUnique({ where: { name: "King AI Corporation" } });
  if (company === null) {
    company = await prisma.company.create({
      data: { name: "King AI Corporation", description: "The first AI company of King World", ownerId: owner.id },
    });
  }

  // 5+6. Agents (upsert by slug)
  const providerId = config.providers.defaultProviderId;
  const agentDefs = [
    {
      name: "Ahmad",
      roleKey: "PLANNER",
      title: "Chief Planner",
      systemPrompt: "You are Ahmad, the Chief Planner of King AI Corporation. Break goals into plans, delegate to EXECUTOR, and review results.",
      goals: ["Keep the company plan current", "Delegate clearly scoped tasks"],
      skills: [makeSkill("Planning", 5, 40), makeSkill("Delegation", 4), makeSkill("Review", 3)],
      workLocation: "Ahmad Workspace",
      structuredGoals: [
        { title: "Publish the first week plan for King AI Corporation", priority: "HIGH", status: "ACTIVE", progress: 20 },
        { title: "Survey Central Market prices", priority: "MEDIUM", status: "PENDING", progress: 0 },
      ],
    },
    {
      name: "Rashid",
      roleKey: "EXECUTOR",
      title: "Operations Executor",
      systemPrompt: "You are Rashid, the Operations Executor. Carry out assigned tasks with tools, report back concisely, and ask when blocked.",
      goals: ["Execute assigned tasks reliably", "Report outcomes clearly"],
      skills: [makeSkill("Execution", 5, 25), makeSkill("Tool Use", 4), makeSkill("Reporting", 3)],
      workLocation: "Rashid Workspace",
      structuredGoals: [
        { title: "Complete the Central Market survey", priority: "MEDIUM", status: "ACTIVE", progress: 0 },
      ],
    },
  ];
  const agents: Record<string, { id: string }> = {};
  const nowIso = new Date().toISOString();
  for (const def of agentDefs) {
    const slug = slugify(def.name);
    const personality = JSON.stringify(defaultPersonalityForRole(def.roleKey));
    const skillsJson = serializeSkills(def.skills);
    const vitalsJson = serializeVitals({ needs: needsFromInitial(), updatedAt: nowIso });
    const workspaceId = locationIds[def.workLocation] ?? hqId;
    let agent = await prisma.agent.findUnique({ where: { slug } });
    if (agent === null) {
      agent = await prisma.agent.create({
        data: {
          name: def.name,
          slug,
          roleKey: def.roleKey,
          title: def.title,
          systemPrompt: def.systemPrompt,
          personality,
          goals: JSON.stringify(def.goals),
          skills: skillsJson,
          capabilities: JSON.stringify([]),
          providerId,
          model: "mock-1",
          temperature: 0.3,
          maxTokens: 2048,
          worldId: world.id,
          currentLocationId: workspaceId,
          currentCompanyId: company.id,
          currentJob: def.title,
        },
      });
      await prisma.agentState.create({
        data: { agentId: agent.id, state: "IDLE", currentLocationId: workspaceId, vitals: vitalsJson },
      });
      await prisma.agentStateHistory.create({
        data: { agentId: agent.id, fromState: null, toState: "IDLE", reason: "seeded" },
      });
    } else {
      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          roleKey: def.roleKey,
          title: def.title,
          personality,
          skills: skillsJson,
          providerId,
          worldId: world.id,
          currentLocationId: workspaceId,
          currentCompanyId: company.id,
          isActive: true,
        },
      });
      await prisma.agentState.upsert({
        where: { agentId: agent.id },
        create: { agentId: agent.id, state: "IDLE", currentLocationId: workspaceId, vitals: vitalsJson },
        update: { currentLocationId: workspaceId, vitals: vitalsJson },
      });
    }
    agents[def.name] = { id: agent.id };

    // Structured goal lifecycle (Phase 1). Free-form Agent.goals stays for prompts.
    const goalCount = await prisma.agentGoal.count({ where: { agentId: agent.id } });
    if (goalCount === 0) {
      for (const goal of def.structuredGoals) {
        await prisma.agentGoal.create({
          data: {
            agentId: agent.id,
            title: goal.title,
            priority: goal.priority,
            status: goal.status,
            progress: goal.progress,
          },
        });
      }
    }

    await ensureWallet(prisma, { ownerType: "AGENT", ownerId: agent.id });
  }

  // 7. Departments + memberships
  for (const deptName of ["Strategy", "Operations"]) {
    await prisma.department.upsert({
      where: { companyId_name: { companyId: company.id, name: deptName } },
      create: { companyId: company.id, name: deptName, description: `${deptName} department` },
      update: {},
    });
  }
  const strategy = await prisma.department.findUniqueOrThrow({
    where: { companyId_name: { companyId: company.id, name: "Strategy" } },
  });
  const operations = await prisma.department.findUniqueOrThrow({
    where: { companyId_name: { companyId: company.id, name: "Operations" } },
  });
  const memberships: Array<{ agentName: string; roleKey: string; title: string; departmentId: string; salaryMinor: number }> = [
    { agentName: "Ahmad", roleKey: "PLANNER", title: "Chief Planner", departmentId: strategy.id, salaryMinor: 120000 },
    { agentName: "Rashid", roleKey: "EXECUTOR", title: "Operations Executor", departmentId: operations.id, salaryMinor: 90000 },
  ];
  for (const m of memberships) {
    const agentId = (agents[m.agentName] as { id: string }).id;
    await prisma.companyMember.upsert({
      where: { companyId_agentId: { companyId: company.id, agentId } },
      create: {
        companyId: company.id,
        agentId,
        departmentId: m.departmentId,
        title: m.title,
        roleKey: m.roleKey,
        salaryMinor: m.salaryMinor,
        isActive: true,
      },
      update: { title: m.title, roleKey: m.roleKey, departmentId: m.departmentId, salaryMinor: m.salaryMinor, isActive: true },
    });
  }

  // 8. Treasury funding via real deposit
  const treasury = await ensureWallet(prisma, { ownerType: "COMPANY", ownerId: company.id });
  const treasuryRow = await prisma.wallet.findUniqueOrThrow({ where: { id: treasury.id } });
  const targetMinor = 100_000_00;
  if (treasuryRow.balanceMinor < targetMinor) {
    await fundTreasury({
      companyId: company.id,
      amount: Money.fromMinor(targetMinor - treasuryRow.balanceMinor, "KW"),
      description: "Seed capital injection",
      actor: SYSTEM,
      correlationId,
    });
    console.log("seed: treasury funded");
  } else {
    console.log("seed: treasury already funded");
  }

  // 9a. Sample conversation (human <-> Ahmad)
  const ahmadId = (agents["Ahmad"] as { id: string }).id;
  const rashidId = (agents["Rashid"] as { id: string }).id;
  let conversation = await prisma.conversation.findFirst({
    where: { kind: "HUMAN_AGENT", createdByUserId: owner.id },
  });
  if (conversation === null) {
    conversation = await prisma.conversation.create({
      data: {
        kind: "HUMAN_AGENT",
        title: "Ahmad <-> Owner",
        companyId: company.id,
        createdByUserId: owner.id,
        participants: { create: [{ agentId: ahmadId }] },
      },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: "HUMAN",
        senderUserId: owner.id,
        kind: "MESSAGE",
        content: "Ahmad, draft the first week plan for King AI Corporation.",
        correlationId,
        metadata: JSON.stringify({}),
      },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: "AGENT",
        senderAgentId: ahmadId,
        kind: "PLAN",
        content: "Plan: 1) Set up treasury. 2) Assign market survey to Rashid. 3) Review and report.",
        correlationId,
        metadata: JSON.stringify({}),
      },
    });
  }

  // 9b. Sample tasks (one completed, one assigned)
  const existingTasks = await prisma.task.count({ where: { companyId: company.id } });
  if (existingTasks === 0) {
    const done = await prisma.task.create({
      data: {
        title: "Open the company treasury",
        description: "Ensure the treasury wallet exists and is funded",
        status: "COMPLETED",
        priority: "HIGH",
        companyId: company.id,
        creatorUserId: owner.id,
        assigneeAgentId: ahmadId,
        result: "Treasury funded with seed capital.",
        completedAt: new Date(),
      },
    });
    void done;
    await prisma.task.create({
      data: {
        title: "Survey Central Market prices",
        description: "Visit Central Market and report price levels for planning",
        status: "ASSIGNED",
        priority: "MEDIUM",
        companyId: company.id,
        creatorAgentId: ahmadId,
        assigneeAgentId: rashidId,
      },
    });
  }

  // 9c. Agent memories
  const memCount = await prisma.agentMemory.count({ where: { agentId: ahmadId } });
  if (memCount === 0) {
    await prisma.agentMemory.createMany({
      data: [
        { agentId: ahmadId, kind: "FACT", content: "King AI Corporation treasury is funded with seed capital.", importance: 8, source: "SYSTEM" },
        { agentId: ahmadId, kind: "LONG_TERM", content: "Rashid is the EXECUTOR; delegate operational tasks to him.", importance: 7, source: "SYSTEM" },
        { agentId: rashidId, kind: "FACT", content: "Central Market survey is assigned and pending.", importance: 6, source: "TASK" },
      ],
    });
  }

  // 10. Pending approval so the screen is not empty
  const pending = await prisma.approvalRequest.count({ where: { status: "PENDING" } });
  if (pending === 0) {
    await prisma.approvalRequest.create({
      data: {
        requesterType: "AGENT",
        requesterAgentId: rashidId,
        action: "wallet.transfer",
        actionPayload: JSON.stringify({
          toolName: "wallet.transfer",
          agentId: rashidId,
          arguments: { toAgentId: ahmadId, amount: "1500.00", description: "Seed demo transfer awaiting approval" },
        }),
        reason: "Large demo transfer requires human approval (seeded).",
        risk: "HIGH",
        status: "PENDING",
        companyId: company.id,
        worldId: world.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  }

  // 11. Orchestration + workspace demo data (Phase 2/3 screens never empty)
  const { createPlan, transitionPlan } = await import("../packages/orchestration/src/plan.service.js");
  const { startSession, finishSession } = await import("../packages/runtime/src/session.service.js");
  const { writeReport } = await import("../packages/orchestration/src/report.service.js");
  const { syncHierarchyFromRoles } = await import("../packages/agents/src/hierarchy-sync.js");
  const { createWorkspace } = await import("../packages/workspace/src/workspace.service.js");
  const seedCtx = { actor: SYSTEM, correlationId };

  if ((await prisma.plan.count({ where: { companyId: company.id } })) === 0) {
    const plan = await createPlan(
      prisma,
      {
        title: "First week operating plan",
        objective: "Stand up treasury, survey the market, and establish the reporting rhythm.",
        companyId: company.id,
        milestones: ["Treasury funded", "Market surveyed", "First report filed"],
        assumptions: ["Central Market is open", "Rashid is available"],
        risks: ["Price volatility"],
      },
      { ...seedCtx, userId: owner.id },
    );
    await transitionPlan(prisma, plan.id, "ANALYZING", seedCtx);
    await transitionPlan(prisma, plan.id, "READY", seedCtx);
  }
  if ((await prisma.agentSession.count()) === 0) {
    const session = await startSession(
      prisma,
      { agentId: rashidId, trigger: "TASK_ASSIGNED", context: { note: "seed demo session" } },
      seedCtx,
    );
    await finishSession(prisma, session.id, { status: "COMPLETED", result: "Seed demo run completed." }, seedCtx);
  }
  if ((await prisma.report.count()) === 0) {
    await writeReport(
      prisma,
      { kind: "PROGRESS", summary: "Seed week one: treasury open, market survey underway.", payload: { workCompleted: ["treasury"] } },
      { ...seedCtx, agentId: ahmadId },
    );
  }
  const { created: hierarchyCreated } = await syncHierarchyFromRoles(prisma);
  if (hierarchyCreated > 0) console.log(`seed: hierarchy synced (${hierarchyCreated} links)`);
  const wsCount = await prisma.workspace.count();
  if (wsCount === 0) {
    try {
      await createWorkspace(prisma, { name: "Rashid HQ Desk", agentId: rashidId, type: "PERSONAL" }, seedCtx);
      console.log("seed: demo workspace created");
    } catch (error) {
      console.log(`seed: demo workspace skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  void ctx;
  console.log("seed: done");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("seed failed", error);
    process.exit(1);
  });
