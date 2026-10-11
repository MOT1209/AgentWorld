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
import { scopeRefs } from "../middleware/company-scope.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import {
  assertCanManageAccess,
  assertCompanyAccess,
  companyScope,
  scopeAllows,
} from "../../../../packages/security/src/company-access.js";
import { notFound } from "../../../../packages/shared/src/index.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";

export const companyRouter: Router = Router();
companyRouter.use(authenticate);
companyRouter.use(scopeRefs);

// Every /:id route below is company-scoped: an invisible company is a 404.
companyRouter.param("id", (req: Request, _res: Response, next: NextFunction, id: string): void => {
  assertCompanyAccess(prisma, getPrincipal(req), id).then(() => next(), next);
});

companyRouter.get(
  "/",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const scope = await companyScope(prisma, getPrincipal(req));
      const companies = (await listCompanies(prisma)).filter((company) => scopeAllows(scope, company.id));
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

// --- Who can see this company --------------------------------------------

companyRouter.get(
  "/:id/access",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const grants = await prisma.companyAccess.findMany({
        where: { companyId: req.params.id as string },
        include: { user: { select: { id: true, email: true, displayName: true, role: true } } },
        orderBy: { createdAt: "asc" },
      });
      res.json({
        data: grants.map((grant) => ({ userId: grant.userId, user: grant.user, grantedBy: grant.grantedBy, createdAt: grant.createdAt })),
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

const GrantAccessSchema = z.object({ email: z.string().email() });

companyRouter.post(
  "/:id/access",
  requirePermission(PERMISSIONS.COMPANY_READ),
  validate("body", GrantAccessSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const companyId = req.params.id as string;
      await assertCanManageAccess(prisma, principal, companyId);
      const body = req.body as z.infer<typeof GrantAccessSchema>;
      const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() }, select: { id: true } });
      if (user === null) throw notFound("User", body.email);
      const grant = await prisma.companyAccess.upsert({
        where: { companyId_userId: { companyId, userId: user.id } },
        create: { companyId, userId: user.id, grantedBy: principal.userId },
        update: {},
      });
      res.status(201).json({ data: { userId: grant.userId, companyId, createdAt: grant.createdAt }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

companyRouter.delete(
  "/:id/access/:userId",
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const companyId = req.params.id as string;
      await assertCanManageAccess(prisma, getPrincipal(req), companyId);
      await prisma.companyAccess.deleteMany({ where: { companyId, userId: req.params.userId as string } });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);
