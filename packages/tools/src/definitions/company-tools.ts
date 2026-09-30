/**
 * Company tools: read-only inspection of the company and its roster.
 *
 * `company.info` doubles as the agent's directory of peers. Because it reports
 * each agent's ROLE KEY and id, an agent can address a colleague correctly
 * without either of them needing to know the other's name.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import {
  getCompanyOverview,
  listDepartments,
  listMembers,
  listProjects,
} from "../../../company/src/index.js";
import { validationError } from "../../../shared/src/index.js";
import type { ToolDefinition } from "../types.js";

export const companyInfoTool: ToolDefinition<{ companyId?: string; includeRoster?: boolean }> = {
  name: "company.info",
  description:
    "Read the company's profile: description, departments, projects, headcount, task counts and " +
    "pending approvals. Set includeRoster=true to also list every agent with their role key, " +
    "which is how you learn who you can address and by what role.",
  inputSchema: z.object({
    companyId: z.string().optional().describe("Defaults to your own company"),
    includeRoster: z.boolean().default(false).describe("Include the agent roster"),
  }),
  requiredPermission: PERMISSIONS.COMPANY_READ,
  risk: "LOW",
  async execute(context, input) {
    const companyId = input.companyId ?? context.companyId;
    if (companyId === undefined || companyId === null) {
      throw validationError("No company is associated with this caller");
    }

    const [overview, departments, projects] = await Promise.all([
      getCompanyOverview(context.db, companyId),
      listDepartments(context.db, companyId),
      listProjects(context.db, companyId),
    ]);

    const base = {
      company: {
        id: overview.company.id,
        name: overview.company.name,
        description: overview.company.description,
      },
      departments: departments.map((department) => ({
        id: department.id,
        name: department.name,
        description: department.description,
      })),
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
      })),
      headcount: overview.agentCount,
      taskCounts: overview.taskCounts,
      pendingApprovals: overview.pendingApprovals,
    };

    if (input.includeRoster !== true) {
      return { data: base, summary: `${base.company.name}: ${base.headcount} agents` };
    }

    const members = await listMembers(context.db, companyId);
    return {
      data: {
        ...base,
        roster: members.map((member) => ({
          agentId: member.agent.id,
          name: member.agent.name,
          title: member.agent.title,
          roleKey: member.agent.roleKey,
          department: member.department?.name ?? null,
          state: member.agent.state?.state ?? null,
          locationId: member.agent.currentLocationId,
          provider: member.agent.providerId,
          model: member.agent.model,
        })),
      },
      summary: `${base.company.name}: ${members.length} agents, ${departments.length} departments`,
    };
  },
};

export const companyTools = [companyInfoTool];
