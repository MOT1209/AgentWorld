import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import {
  createCompany,
  createDepartment,
  addMember,
  listMembers,
  getCompanyOverview,
} from "../packages/company/src/index.js";
import {
  createWorld,
  createCity,
  createLocation,
  getWorldSnapshot,
  tickWorld,
  moveAgent,
  getSimulatedTime,
} from "../packages/world/src/index.js";
import { eventBus, EVENT_TYPES } from "../packages/events/src/index.js";
import { listActivity } from "../packages/events/src/audit.js";
import { permissionsForRole } from "../packages/security/src/rbac.js";
import { UserRole } from "../packages/shared/src/index.js";
import { SYSTEM, CORRELATION, createTestAgent, createTestUser, unique } from "./helpers.js";

describe("company", () => {
  it("manages structure, memberships, and overviews", async () => {
    const owner = await createTestUser();
    const company = await createCompany(
      prisma,
      { name: unique("Company"), ownerId: owner.id },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    const dept = await createDepartment(
      prisma,
      { companyId: company.id, name: "Research" },
      { actor: SYSTEM, correlationId: CORRELATION, permissions: new Set(["company.structure.modify"]) },
    );
    const agent = await createTestAgent({ name: "Member Agent", companyId: company.id });
    const member = await addMember(
      prisma,
      { companyId: company.id, agentId: agent.id, roleKey: "ANALYST", title: "Analyst", departmentId: dept.id },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    expect(member.agentId).toBe(agent.id);

    const members = await listMembers(prisma, company.id);
    expect(members.length).toBeGreaterThan(0);

    const overview = await getCompanyOverview(prisma, company.id);
    expect(overview.company.id).toBe(company.id);
    expect(overview.memberCount).toBeGreaterThanOrEqual(1);
  });
});

describe("world", () => {
  it("creates geography, snapshots, ticks, and moves agents", async () => {
    const world = await createWorld(prisma, { name: unique("World") }, { actor: SYSTEM, correlationId: CORRELATION });
    const city = await createCity(prisma, { worldId: world.id, name: unique("City") }, { actor: SYSTEM });
    const loc = await createLocation(
      prisma,
      { cityId: city.id, name: unique("HQ"), kind: "HQ" },
      { actor: SYSTEM },
    );
    const agent = await createTestAgent({ name: "Traveler", worldId: world.id });
    await moveAgent(prisma, { agentId: agent.id, toLocationId: loc.id }, { actor: SYSTEM });

    const snapshot = await getWorldSnapshot(prisma, world.id);
    expect(snapshot.locations.length).toBeGreaterThan(0);

    const before = await getSimulatedTime(prisma, world.id);
    const ticked = await tickWorld(prisma, world.id);
    expect(ticked.world.timeOffsetMinutes).toBeGreaterThanOrEqual(before.offsetMinutes);

    const moved = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(moved.currentLocationId).toBe(loc.id);
  });
});

describe("events and permissions", () => {
  it("persists bus events and audit rows", async () => {
    let seen = 0;
    const off = eventBus.subscribe(EVENT_TYPES.AGENT_OBSERVATION, () => {
      seen += 1;
    });
    await eventBus.publishAndDispatch(prisma, {
      type: EVENT_TYPES.AGENT_OBSERVATION,
      actor: SYSTEM,
      correlationId: CORRELATION,
      payload: { agentId: "x", category: "NOTE", note: "hello" },
    });
    off();
    expect(seen).toBe(1);

    const activity = await listActivity(prisma, { take: 5 });
    expect(Array.isArray(activity)).toBe(true);
  });

  it("grants OWNER strictly more than OBSERVER", async () => {
    const observer = permissionsForRole(UserRole.OBSERVER);
    const owner = permissionsForRole(UserRole.OWNER);
    expect(owner.length).toBeGreaterThan(observer.length);
    expect(observer).toContain("world.read");
    expect(observer).not.toContain("wallet.transfer");
    expect(owner).toContain("wallet.transfer");
  });
});
