import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import {
  createCompany,
  createDepartment,
  addMember,
  listMembers,
  listDepartments,
  createProject,
  listProjects,
  getCompanyOverview,
  listCompanies,
  getCompany,
  listCompanyAgents,
} from "../../../../packages/company/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";

export const companyRouter: Router = Router();
companyRouter.use(authenticate);

companyRouter.get(
  "/",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const companies = await listCompanies(prisma);
      res.json({ data: companies, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const CreateCompanySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

companyRouter.post(
  "/",
  requirePermission(PERMISSIONS.COMPANY_WRITE),
  validate("body", CreateCompanySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateCompanySchema>;
      const company = await createCompany(
        prisma,
        { name: body.name, description: body.description, ownerId: principal.userId },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req), userId: principal.userId },
      );
      res.status(201).json({ data: company, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

companyRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const company = await getCompany(prisma, req.params.id as string);
      res.json({ data: company, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

companyRouter.get(
  "/:id/overview",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const overview = await getCompanyOverview(prisma, req.params.id as string);
      res.json({ data: overview, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

companyRouter.get(
  "/:id/members",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const members = await listMembers(prisma, req.params.id as string);
      res.json({ data: members, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

companyRouter.get(
  "/:id/departments",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const departments = await listDepartments(prisma, req.params.id as string);
      res.json({ data: departments, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

companyRouter.get(
  "/:id/projects",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const projects = await listProjects(prisma, req.params.id as string);
      res.json({ data: projects, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

companyRouter.get(
  "/:id/agents",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const agents = await listCompanyAgents(prisma, req.params.id as string);
      res.json({ data: agents, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const CreateDepartmentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

companyRouter.post(
  "/:id/departments",
  requirePermission(PERMISSIONS.COMPANY_STRUCTURE_MODIFY),
  validate("body", CreateDepartmentSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateDepartmentSchema>;
      const department = await createDepartment(
        prisma,
        { companyId: req.params.id as string, name: body.name, description: body.description },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req), userId: principal.userId },
      );
      res.status(201).json({ data: department, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const AddMemberSchema = z.object({
  agentId: z.string().min(1),
  roleKey: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  departmentId: z.string().min(1).optional().nullable(),
  salaryMinor: z.number().int().min(0).max(2147483647).optional(),
});

companyRouter.post(
  "/:id/members",
  requirePermission(PERMISSIONS.COMPANY_STRUCTURE_MODIFY),
  validate("body", AddMemberSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof AddMemberSchema>;
      const member = await addMember(
        prisma,
        {
          companyId: req.params.id as string,
          agentId: body.agentId,
          roleKey: body.roleKey,
          title: body.title,
          departmentId: body.departmentId ?? null,
          ...(body.salaryMinor !== undefined ? { salaryMinor: body.salaryMinor } : {}),
        },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req), userId: principal.userId },
      );
      res.status(201).json({ data: member, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

companyRouter.post(
  "/:id/projects",
  requirePermission(PERMISSIONS.COMPANY_WRITE),
  validate("body", CreateProjectSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateProjectSchema>;
      const project = await createProject(
        prisma,
        { companyId: req.params.id as string, name: body.name, description: body.description },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req), userId: principal.userId },
      );
      res.status(201).json({ data: project, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
