/**
 * Company, departments, membership.
 *
 * An "employee" is a CompanyMember row joining an agent to a company. Agents can
 * be members of several companies in principle; Phase 1 uses one, but the
 * composite key already supports the general case.
 *
 * `roleKey` on the membership is what drives behaviour, via the RoleProfile
 * registry. Ahmad and Rashid are not special-cased anywhere: they are two rows
 * with two different roleKeys.
 */
import {
  newCorrelationId,
  validationError,
  type ActorRef,
} from "../../shared/src/index.js";
import { conflict, forbidden, notFound } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { Agent, Company, CompanyMember, Department, Project } from "../../database/src/types.js";
import { eventBus } from "../../events/src/index.js";
import { recordActivity } from "../../events/src/audit.js";
import { EVENT_TYPES } from "../../events/src/index.js";
import { PERMISSIONS, type Permission } from "../../security/src/permissions.js";

export interface CompanyContext {
  actor: ActorRef;
  correlationId?: string;
  permissions?: ReadonlySet<Permission>;
  userId?: string;
}

export async function createCompany(
  db: DbClient,
  input: { name: string; description?: string; ownerId: string },
  ctx: CompanyContext,
): Promise<Company> {
  const correlationId = ctx.correlationId ?? newCorrelationId();
  const owner = await db.user.findUnique({ where: { id: input.ownerId } });
  if (owner === null) throw notFound("Owner user", input.ownerId);

  const existing = await db.company.findUnique({ where: { name: input.name } });
  if (existing !== null) {
    throw conflict("A company with that name already exists", { name: input.name });
  }

  const company = await db.company.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      ownerId: input.ownerId,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.COMPANY_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "Company",
    targetId: company.id,
    companyId: company.id,
    payload: { companyId: company.id, name: company.name, ownerId: input.ownerId },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "company.create",
    targetType: "Company",
    targetId: company.id,
    correlationId,
    userId: ctx.userId,
    metadata: { name: company.name, ownerId: input.ownerId },
  });

  return company;
}

export async function getCompany(db: DbClient, companyId: string): Promise<Company> {
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (company === null) throw notFound("Company", companyId);
  return company;
}

export async function listCompanies(db: DbClient): Promise<Company[]> {
  return db.company.findMany({ orderBy: { name: "asc" } });
}

export async function createDepartment(
  db: DbClient,
  input: { companyId: string; name: string; description?: string },
  ctx: CompanyContext,
): Promise<Department> {
  assertCanModifyStructure(ctx);
  const correlationId = ctx.correlationId ?? newCorrelationId();
  await getCompany(db, input.companyId);

  const department = await db.department.upsert({
    where: { companyId_name: { companyId: input.companyId, name: input.name } },
    create: {
      companyId: input.companyId,
      name: input.name,
      description: input.description ?? null,
    },
    update: { description: input.description ?? undefined },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.DEPARTMENT_CREATED,
    actor: ctx.actor,
    correlationId,
    targetType: "Department",
    targetId: department.id,
    companyId: input.companyId,
    payload: { companyId: input.companyId, departmentId: department.id, name: department.name },
  });

  return department;
}

export async function addMember(
  db: DbClient,
  input: {
    companyId: string;
    agentId: string;
    roleKey: string;
    title: string;
    departmentId?: string | null;
    salaryMinor?: number;
  },
  ctx: CompanyContext,
): Promise<CompanyMember> {
  assertCanModifyStructure(ctx);
  const correlationId = ctx.correlationId ?? newCorrelationId();

  const company = await getCompany(db, input.companyId);
  const agent = await db.agent.findUnique({ where: { id: input.agentId } });
  if (agent === null) throw notFound("Agent", input.agentId);

  if (input.salaryMinor !== undefined && (!Number.isInteger(input.salaryMinor) || input.salaryMinor < 0)) {
    throw validationError("Salary must be a non-negative integer of minor units");
  }

  const existing = await db.companyMember.findUnique({
    where: { companyId_agentId: { companyId: input.companyId, agentId: input.agentId } },
  });
  if (existing !== null) {
    throw conflict("Agent is already a member of this company", {
      companyId: input.companyId,
      agentId: input.agentId,
    });
  }

  const member = await db.companyMember.create({
    data: {
      companyId: company.id,
      agentId: input.agentId,
      roleKey: input.roleKey,
      title: input.title,
      departmentId: input.departmentId ?? null,
      salaryMinor: input.salaryMinor ?? 0,
    },
  });

  // Keep the agent's denormalised world pointers consistent.
  await db.agent.update({
    where: { id: input.agentId },
    data: {
      currentCompanyId: company.id,
      currentJob: input.title,
      roleKey: input.roleKey,
    },
  });

  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.COMPANY_STRUCTURE_MODIFIED,
    actor: ctx.actor,
    correlationId,
    targetType: "CompanyMember",
    targetId: member.id,
    companyId: company.id,
    payload: { companyId: company.id, change: "member_added" },
  });

  await recordActivity(db, {
    actor: ctx.actor,
    action: "company.add_member",
    targetType: "Agent",
    targetId: input.agentId,
    correlationId,
    userId: ctx.userId,
    metadata: { companyId: company.id, roleKey: input.roleKey, title: input.title },
  });

  return member;
}

export async function listMembers(db: DbClient, companyId: string) {
  return db.companyMember.findMany({
    where: { companyId },
    include: {
      agent: {
        select: {
          id: true,
          name: true,
          title: true,
          roleKey: true,
          providerId: true,
          model: true,
          currentLocationId: true,
          reputation: true,
          state: { select: { state: true, activity: true } },
        },
      },
      department: { select: { id: true, name: true } },
    },
    orderBy: { joinedAt: "asc" },
  });
}

export async function listDepartments(db: DbClient, companyId: string): Promise<Department[]> {
  return db.department.findMany({ where: { companyId }, orderBy: { name: "asc" } });
}

export async function createProject(
  db: DbClient,
  input: { companyId: string; name: string; description?: string },
  _ctx: CompanyContext,
): Promise<Project> {
  const company = await getCompany(db, input.companyId);
  const existing = await db.project.findUnique({
    where: { companyId_name: { companyId: input.companyId, name: input.name } },
  });
  if (existing !== null) {
    throw conflict("A project with that name already exists in this company");
  }
  return db.project.create({
    data: {
      companyId: company.id,
      name: input.name,
      description: input.description ?? null,
    },
  });
}

export async function listProjects(db: DbClient, companyId: string): Promise<Project[]> {
  return db.project.findMany({ where: { companyId }, orderBy: { name: "asc" } });
}

export interface CompanyOverview {
  company: Company;
  departments: Department[];
  projects: Project[];
  memberCount: number;
  agentCount: number;
  taskCounts: Record<string, number>;
  pendingApprovals: number;
}

export async function getCompanyOverview(
  db: DbClient,
  companyId: string,
): Promise<CompanyOverview> {
  const company = await getCompany(db, companyId);
  const [departments, projects, members, agentCount, taskGroups, pendingApprovals] =
    await Promise.all([
      listDepartments(db, companyId),
      listProjects(db, companyId),
      db.companyMember.count({ where: { companyId, isActive: true } }),
      db.agent.count({ where: { currentCompanyId: companyId } }),
      db.task.groupBy({ by: ["status"], where: { companyId }, _count: { _all: true } }),
      db.approvalRequest.count({ where: { companyId, status: "PENDING" } }),
    ]);

  const taskCounts: Record<string, number> = {};
  for (const group of taskGroups) taskCounts[group.status] = group._count._all;

  return { company, departments, projects, memberCount: members, agentCount, taskCounts, pendingApprovals };
}

export async function listCompanyAgents(db: DbClient, companyId: string): Promise<Agent[]> {
  return db.agent.findMany({
    where: { currentCompanyId: companyId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Agents that hold a given role inside a company. This is how a caller asks
 * "who is the executor?" without hard-coding an agent name.
 */
export async function findAgentsByRole(
  db: DbClient,
  companyId: string,
  roleKey: string,
): Promise<Agent[]> {
  return db.agent.findMany({
    where: { currentCompanyId: companyId, roleKey, isActive: true },
    orderBy: { createdAt: "asc" },
  });
}

function assertCanModifyStructure(ctx: CompanyContext): void {
  if (ctx.actor.actorType === "SYSTEM") return;
  if (ctx.permissions === undefined) return;
  if (!ctx.permissions.has(PERMISSIONS.COMPANY_STRUCTURE_MODIFY)) {
    throw forbidden("Modifying company structure requires 'company.structure.modify'");
  }
}
