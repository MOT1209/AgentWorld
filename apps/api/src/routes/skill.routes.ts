/**
 * External skills ecosystem API.
 *
 * Flow per route:
 *   DISCOVER (GET /discover) -> INSPECT (POST /external/inspect) ->
 *   INSTALL (POST /external/install, approval-gated) -> REGISTER/ENABLE ->
 *   ASSIGN (POST /:key/assign, compatibility-checked) -> MONITOR (usage) ->
 *   UPDATE (POST /:key/update, diff + re-approval on widen) ->
 *   DISABLE / REMOVE.
 *
 * Dangerous operations respect the existing approval system: when a plan
 * requires human review, the route creates an ApprovalRequest
 * (action `skill.install` / `skill.update` / `skill.assign`) and returns
 * 202. The caller approves via /approvals/:id/decision, then retries with
 * `approvalRequestId`. Installation never grants execution rights; the
 * tool executor's capability -> permission -> policy -> approval chain
 * still governs every run.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { prisma } from "../../../../packages/database/src/index.js";
import { authenticate, getPrincipal } from "../middleware/authenticate.js";
import { scopeRefs, scoped } from "../middleware/company-scope.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { validate } from "../middleware/validate.js";
import { eventBus, EVENT_TYPES, type EventType } from "../../../../packages/events/src/index.js";
import { recordActivity } from "../../../../packages/events/src/audit.js";
import {
  claimForExecution,
  markExecutionFailed,
  markExecutionSucceeded,
  readApprovalPayload,
  requestApproval,
} from "../../../../packages/approvals/src/index.js";
import { roleProfiles } from "../../../../packages/agents/src/role-profiles.js";
import { forbidden, isAppError, validationError } from "../../../../packages/shared/src/index.js";
import {
  SkillDiscoveryQuerySchema,
  SkillSourceSchema,
  analyzeExternalSkill,
  buildInstallationRecord,
  buildLockfile,
  buildReputation,
  checkAssignmentCompatibility,
  decideSkillRequest,
  findRollbackTarget,
  normalizeExternalSkill,
  parseLockfile,
  planInstallation,
  planUpdate,
  sandboxInstructions,
  skillIntegrityHash,
  verifyIntegrity,
  verifyLockfile,
  type SkillCatalogRecord,
  type SkillSourceType,
} from "../../../../packages/skills/src/index.js";
import { skillProviders, skillStore } from "../services/skill-store.js";

export const skillRouter: Router = Router();
skillRouter.use(authenticate);
skillRouter.use(scopeRefs);

function actorCtx(req: Request): {
  actor: ReturnType<typeof principalToActor>;
  userId: string;
  correlationId: string;
} {
  const principal = getPrincipal(req);
  return {
    actor: principalToActor(principal),
    userId: principal.userId,
    correlationId: getCorrelationId(req),
  };
}

type SkillEventPayload = Record<string, string | number | boolean | null | string[]>;

async function publishSkillEvent(
  req: Request,
  type: EventType,
  payload: SkillEventPayload,
  targetId: string,
  action: string,
): Promise<void> {
  const ctx = actorCtx(req);
  const publish = eventBus.publishAndDispatch.bind(eventBus) as (
    db: typeof prisma,
    event: unknown,
  ) => Promise<unknown>;
  await publish(prisma, {
    type,
    actor: ctx.actor,
    correlationId: ctx.correlationId,
    targetType: targetTypeFor(type),
    targetId,
    payload,
  });
  await recordActivity(prisma, {
    actor: ctx.actor,
    action,
    targetType: targetTypeFor(type),
    targetId,
    correlationId: ctx.correlationId,
    userId: ctx.userId,
    metadata: payload,
  });
}

function targetTypeFor(type: string): string {
  if (type === "SKILL_REQUESTED") return "SkillRequest";
  if (type === "SKILL_DISCOVERED") return "SkillCatalog";
  return "Skill";
}

function toCard(r: SkillCatalogRecord): Record<string, unknown> {
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    author: r.author,
    version: r.installedVersion ?? r.availableVersion,
    installedVersion: r.installedVersion,
    availableVersion: r.availableVersion,
    source: r.source.type,
    trust: r.trust,
    risk: r.risk,
    installed: r.installed,
    enabled: r.enabled,
    status: r.status,
    compatibility: r.compatibility,
    category: r.category,
    lastChecked: r.lastChecked,
    lastUpdated: r.lastUpdated,
  };
}

// -- Sources -----------------------------------------------------------------

skillRouter.get(
  "/sources",
  requirePermission(PERMISSIONS.AGENT_READ),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      res.json({
        data: {
          sources: skillProviders.types().map((t) => ({ type: t })),
          builtin: ["SYSTEM", "AGENTWORLD", "SKILLS_SH", "GITHUB", "USER", "COMMUNITY", "ORGANIZATION", "LOCAL"],
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

// -- Discovery ---------------------------------------------------------------

const DiscoverQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: z.string().max(120).optional(),
  author: z.string().max(200).optional(),
  repository: z.string().max(2000).optional(),
  keyword: z.string().max(200).optional(),
  compatibility: z.string().max(40).optional(),
  source: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

skillRouter.get(
  "/discover",
  requirePermission(PERMISSIONS.AGENT_READ),
  validate("query", DiscoverQuerySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as unknown as z.infer<typeof DiscoverQuerySchema>;
      const query = SkillDiscoveryQuerySchema.parse({
        ...(q.search !== undefined ? { search: q.search } : {}),
        ...(q.category !== undefined ? { category: q.category } : {}),
        ...(q.author !== undefined ? { author: q.author } : {}),
        ...(q.repository !== undefined ? { repository: q.repository } : {}),
        ...(q.keyword !== undefined ? { keyword: q.keyword } : {}),
        ...(q.compatibility !== undefined ? { compatibility: q.compatibility } : {}),
        limit: q.limit,
      });
      const items: Array<Record<string, unknown>> = [];
      // Local catalog is always searchable offline.
      for (const hit of await skillStore.search({
        ...(q.search !== undefined ? { search: q.search } : {}),
        ...(q.category !== undefined ? { category: q.category } : {}),
        ...(q.author !== undefined ? { author: q.author } : {}),
        ...(q.repository !== undefined ? { repository: q.repository } : {}),
        ...(q.keyword !== undefined ? { keyword: q.keyword } : {}),
        limit: q.limit,
      })) {
        items.push(toCard(hit));
      }
      // External providers contribute when configured; failures degrade to
      // catalog-only results instead of failing discovery.
      const installedKeys = new Set((await skillStore.list()).map((r) => r.key));
      const wanted: SkillSourceType[] =
        q.source !== undefined && skillProviders.types().includes(q.source as SkillSourceType)
          ? [q.source as SkillSourceType]
          : skillProviders.types();
      for (const sourceType of wanted) {
        try {
          const listings = await skillProviders.get(sourceType).discover(query);
          for (const listing of listings) {
            if (items.some((i) => i.key === listing.externalId)) continue;
            items.push({
              key: listing.externalId,
              name: listing.name,
              description: listing.description,
              author: listing.author ?? null,
              version: listing.version ?? null,
              source: listing.source.type,
              trust: "UNVERIFIED",
              installed: installedKeys.has(listing.externalId),
            });
            if (items.length >= q.limit) break;
          }
        } catch {
          continue;
        }
        if (items.length >= q.limit) break;
      }
      const ctx = actorCtx(req);
      const publish = eventBus.publishAndDispatch.bind(eventBus) as (
        db: typeof prisma,
        event: unknown,
      ) => Promise<unknown>;
      await publish(prisma, {
        type: EVENT_TYPES.SKILL_DISCOVERED,
        actor: ctx.actor,
        correlationId: ctx.correlationId,
        targetType: "SkillCatalog",
        targetId: "discover",
        payload: { source: q.source ?? "all", count: items.length },
      });
      res.json({ data: { items }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Local catalog -----------------------------------------------------------

skillRouter.get(
  "/catalog",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json({ data: { items: (await skillStore.list()).map(toCard) }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Inspection (before installation) ----------------------------------------

const InspectSchema = z.object({
  source: SkillSourceSchema,
  externalId: z.string().min(1).max(500),
  manifest: z.unknown(),
  files: z.record(z.string(), z.string()).optional(),
});

skillRouter.post(
  "/external/inspect",
  requirePermission(PERMISSIONS.AGENT_READ),
  validate("body", InspectSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as unknown as z.infer<typeof InspectSchema>;
      let manifest: ReturnType<typeof normalizeExternalSkill>;
      try {
        manifest = normalizeExternalSkill(body.manifest, { externalId: body.externalId, source: body.source });
      } catch (normalizeError) {
        throw asSkillPlanError(normalizeError);
      }
      const files = body.files ?? {};
      const report = analyzeExternalSkill(manifest, files);
      await publishSkillEvent(
        req,
        EVENT_TYPES.SKILL_INSPECTED,
        { skillKey: manifest.key, source: body.source.type, trust: "UNVERIFIED", risk: report.riskLevel },
        manifest.key,
        "skill.inspect",
      );
      res.json({
        data: {
          manifest,
          securityReport: report,
          sandboxedInstructions: sandboxInstructions(manifest),
          installationStatus: (await skillStore.get(manifest.key))?.status ?? "NOT_INSTALLED",
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

// -- Installation (approval-gated) -------------------------------------------

const InstallSchema = z.object({
  source: SkillSourceSchema,
  externalId: z.string().min(1).max(500),
  manifest: z.unknown(),
  files: z.record(z.string(), z.string()).optional(),
  allowedPermissions: z.array(z.string().max(120)).max(100).nullable().optional(),
  enable: z.boolean().default(false),
  approvalRequestId: z.string().min(1).optional(),
});

/**
 * Claims an APPROVED approval for exactly this operation. The approval must
 * name the same action AND the same target (`matches` checks the stored
 * payload), and it is single-use: the claim marks it executed, so an
 * approval for one skill/agent can neither unlock another nor be replayed.
 * Any failure means "not approved" and the caller files a fresh request.
 */
async function claimApproval(
  approvalRequestId: string | undefined,
  action: string,
  matches: (payload: Record<string, unknown>) => boolean,
): Promise<string> {
  if (approvalRequestId === undefined) throw new Error("APPROVAL_REQUIRED");
  const approval = await prisma.approvalRequest.findUnique({ where: { id: approvalRequestId } });
  if (approval === null || approval.action !== action || approval.status !== "APPROVED") {
    throw new Error("A valid APPROVED approval request is required before continuing.");
  }
  // requestApproval stores `{ toolName, agentId, arguments }`; the skill
  // route's own payload is `arguments`.
  const payload = readApprovalPayload(approval).arguments;
  if (!matches(payload)) throw new Error("The approval was granted for a different request.");
  const claimed = await claimForExecution(prisma, approval.id);
  if (claimed === null) throw new Error("The approval has already been used.");
  return approval.id;
}

/** Runs the approved commit; releases the claim if the commit itself failed. */
async function underApproval<T>(approvalId: string | null, commit: () => Promise<T>): Promise<T> {
  try {
    const result = await commit();
    if (approvalId !== null) await markExecutionSucceeded(prisma, approvalId);
    return result;
  } catch (error) {
    if (approvalId !== null) {
      await markExecutionFailed(prisma, approvalId, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Planning/normalizing a skill fails for expected reasons (security block,
 * invalid manifest, non-newer update). Those are client errors with a
 * message worth showing, not 500s.
 */
function asSkillPlanError(error: unknown): Error {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return /blocked/i.test(message) ? forbidden(message.slice(0, 1000)) : validationError(message.slice(0, 1000));
}

function manifestOf(payload: Record<string, unknown>): { key?: unknown } {
  const manifest = payload.manifest;
  return manifest !== null && typeof manifest === "object" ? (manifest as { key?: unknown }) : {};
}

skillRouter.post(
  "/external/install",
  requirePermission(PERMISSIONS.AGENT_CREATE),
  validate("body", InstallSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as unknown as z.infer<typeof InstallSchema>;
      const ctx = actorCtx(req);
      let plan: ReturnType<typeof planInstallation>;
      try {
        plan = planInstallation({
          source: body.source,
          externalId: body.externalId,
          rawManifest: body.manifest,
          files: body.files ?? {},
          allowedPermissions: body.allowedPermissions ?? null,
          autoEnable: body.enable,
        });
      } catch (planError) {
        const message = planError instanceof Error ? planError.message : String(planError);
        await recordActivity(prisma, {
          actor: ctx.actor,
          action: "skill.install",
          targetType: "Skill",
          targetId: body.externalId,
          result: "ERROR",
          error: message,
          correlationId: ctx.correlationId,
          userId: ctx.userId,
          metadata: { source: body.source.type, externalId: body.externalId },
        });
        if (message.includes("blocked") || message.includes("BLOCKED")) {
          const publish = eventBus.publishAndDispatch.bind(eventBus) as (
            db: typeof prisma,
            event: unknown,
          ) => Promise<unknown>;
          await publish(prisma, {
            type: EVENT_TYPES.SKILL_BLOCKED,
            actor: ctx.actor,
            correlationId: ctx.correlationId,
            targetType: "Skill",
            targetId: body.externalId,
            payload: { skillKey: body.externalId, reason: message.slice(0, 500) },
          });
        }
        throw asSkillPlanError(planError);
      }
      let approvalId: string | null = null;
      if (plan.approvalRequired) {
        try {
          approvalId = await claimApproval(body.approvalRequestId, "skill.install", (payload) =>
            // The integrity hash covers manifest + files, so an approval for
            // one content cannot install different content under the same version.
            payload.externalId === body.externalId &&
            manifestOf(payload).key === plan.manifest.key &&
            payload.integrityHash === plan.integrityHash,
          );
        } catch {
          const approval = await requestApproval(
            prisma,
            {
              action: "skill.install",
              actionPayload: { source: body.source, externalId: body.externalId, manifest: plan.manifest, integrityHash: plan.integrityHash },
              reason: `Skill '${plan.manifest.key}' requires human review: ${plan.approvalReason ?? "review required"}.`,
              risk: plan.securityReport.riskLevel === "LOW" ? "MEDIUM" : plan.securityReport.riskLevel,
              requester: ctx.actor,
              requesterAgentId: null,
            },
            { actor: ctx.actor, correlationId: ctx.correlationId, userId: ctx.userId },
          );
          res.status(202).json({
            data: {
              status: "APPROVAL_REQUIRED",
              approvalRequestId: approval.id,
              reason: plan.approvalReason,
              securityReport: plan.securityReport,
              trust: plan.trust,
              requestedPermissions: plan.permissionReview.requested,
              allowedPermissions: plan.permissionReview.allowed,
            },
            correlationId: getCorrelationId(req),
          });
          return;
        }
      }
      const record = await underApproval(approvalId, async () =>
        skillStore.saveWithUsage(
          buildInstallationRecord(await skillStore.get(plan.manifest.key), body.source, body.externalId, plan, { enable: body.enable }),
          { kind: "installation" },
        ),
      );
      await publishSkillEvent(
        req,
        EVENT_TYPES.SKILL_INSTALLED,
        {
          skillKey: record.key,
          version: record.installedVersion ?? "",
          source: record.source.type,
          trust: record.trust,
          risk: record.risk,
        },
        record.key,
        "skill.install",
      );
      res.status(201).json({ data: { skill: toCard(record), securityReport: plan.securityReport }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Detail / security report -------------------------------------------------

skillRouter.get(
  "/:key",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const record = await skillStore.get(req.params.key as string);
      if (record === undefined) {
        res.status(404).json({ message: `Unknown skill '${req.params.key as string}'`, correlationId: getCorrelationId(req) });
        return;
      }
      res.json({
        data: {
          skill: toCard(record),
          manifest: record.manifest,
          securityReport: record.securityReport,
          grantedPermissions: record.grantedPermissions,
          deniedPermissions: record.deniedPermissions,
          versionHistory: record.versionHistory,
          agents: await skillStore.agentsForSkill(record.key),
          usage: await skillStore.usage(record.key),
        },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

skillRouter.get(
  "/:key/security-report",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const record = await skillStore.get(req.params.key as string);
      if (record?.securityReport === undefined || record.securityReport === null) {
        res.status(404).json({ message: "No security report for this skill", correlationId: getCorrelationId(req) });
        return;
      }
      res.json({ data: record.securityReport, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Update / rollback ---------------------------------------------------------

const UpdateSchema = z.object({
  manifest: z.unknown(),
  files: z.record(z.string(), z.string()).optional(),
  approvalRequestId: z.string().min(1).optional(),
});

skillRouter.post(
  "/:key/update",
  requirePermission(PERMISSIONS.AGENT_CREATE),
  validate("body", UpdateSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = req.params.key as string;
      const body = req.body as unknown as z.infer<typeof UpdateSchema>;
      const record = await skillStore.get(key);
      if (record?.manifest === null || record?.manifest === undefined) {
        res.status(404).json({ message: `Skill '${key}' is not installed`, correlationId: getCorrelationId(req) });
        return;
      }
      const ctx = actorCtx(req);
      const installed = record.manifest;
      let planned: ReturnType<typeof planUpdate>;
      try {
        planned = planUpdate(installed, body.manifest, record.source, record.externalId, body.files ?? {});
      } catch (planError) {
        throw asSkillPlanError(planError);
      }
      let approvalId: string | null = null;
      if (planned.approvalRequired) {
        try {
          approvalId = await claimApproval(body.approvalRequestId, "skill.update", (payload) =>
            payload.skillKey === key &&
            payload.from === installed.version &&
            payload.to === planned.manifest.version &&
            payload.integrityHash === planned.integrityHash,
          );
        } catch {
          const approval = await requestApproval(
            prisma,
            {
              action: "skill.update",
              actionPayload: { skillKey: key, from: installed.version, to: planned.manifest.version, integrityHash: planned.integrityHash },
              reason: `Skill update '${key}' ${installed.version} -> ${planned.manifest.version} requires review: ${planned.approvalReason ?? "changes detected"}.`,
              risk: planned.securityReport.riskLevel === "LOW" ? "MEDIUM" : planned.securityReport.riskLevel,
              requester: ctx.actor,
              requesterAgentId: null,
            },
            { actor: ctx.actor, correlationId: ctx.correlationId, userId: ctx.userId },
          );
          res.status(202).json({
            data: { status: "APPROVAL_REQUIRED", approvalRequestId: approval.id, diff: planned.diff, securityReport: planned.securityReport },
            correlationId: getCorrelationId(req),
          });
          return;
        }
      }
      const updated = await underApproval(approvalId, () =>
        skillStore.saveWithUsage(
          buildInstallationRecord(record, record.source, record.externalId, planned, { enable: record.enabled }),
          { kind: "update" },
        ),
      );
      await publishSkillEvent(
        req,
        EVENT_TYPES.SKILL_UPDATED,
        { skillKey: key, fromVersion: installed.version, toVersion: updated.installedVersion ?? "" },
        key,
        "skill.update",
      );
      res.json({ data: { skill: toCard(updated), diff: planned.diff }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

skillRouter.post(
  "/:key/rollback",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = req.params.key as string;
      const record = await skillStore.get(key);
      if (record?.installedVersion === null || record?.installedVersion === undefined) {
        res.status(404).json({ message: `Skill '${key}' is not installed`, correlationId: getCorrelationId(req) });
        return;
      }
      // Only versions whose own manifest was recorded can be restored; using
      // the current manifest under an older version number would be a lie.
      const history = record.versionHistory.flatMap((h) =>
        h.manifest !== undefined
          ? [{ version: h.version, integrityHash: h.integrityHash, manifest: h.manifest, installedAt: h.installedAt }]
          : [],
      );
      const target = findRollbackTarget(history, record.installedVersion);
      if (target === null) {
        res.status(409).json({ message: "No previous verified version to roll back to", correlationId: getCorrelationId(req) });
        return;
      }
      const rolled: SkillCatalogRecord = {
        ...record,
        installedVersion: target.version,
        manifest: target.manifest,
        integrityHash: target.integrityHash,
        // Never keep a grant the restored version does not even request.
        grantedPermissions: record.grantedPermissions.filter((p) => target.manifest.permissions.includes(p)),
        status: record.enabled ? "ENABLED" : "INSTALLED",
        lastUpdated: new Date().toISOString(),
      };
      await skillStore.saveWithUsage(rolled, { kind: "rollback" });
      await publishSkillEvent(
        req,
        EVENT_TYPES.SKILL_ROLLBACK,
        { skillKey: key, fromVersion: record.installedVersion, toVersion: target.version },
        key,
        "skill.rollback",
      );
      res.json({ data: { skill: toCard(rolled) }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Enable / disable / remove --------------------------------------------------

skillRouter.post(
  "/:key/enable",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const record = await skillStore.get(req.params.key as string);
      if (record === undefined) {
        res.status(404).json({ message: "Unknown skill", correlationId: getCorrelationId(req) });
        return;
      }
      if (record.trust === "BLOCKED" || record.status === "BLOCKED") {
        res.status(403).json({ message: "Blocked skills cannot be enabled", correlationId: getCorrelationId(req) });
        return;
      }
      const updated: SkillCatalogRecord = { ...record, enabled: true, status: "ENABLED", lastUpdated: new Date().toISOString() };
      await skillStore.save(updated);
      await publishSkillEvent(req, EVENT_TYPES.SKILL_ENABLED, { skillKey: updated.key }, updated.key, "skill.enable");
      res.json({ data: { skill: toCard(updated) }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const DisableSchema = z.object({ reason: z.string().max(1000).optional() });

skillRouter.post(
  "/:key/disable",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", DisableSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const record = await skillStore.get(req.params.key as string);
      if (record === undefined) {
        res.status(404).json({ message: "Unknown skill", correlationId: getCorrelationId(req) });
        return;
      }
      const body = req.body as unknown as z.infer<typeof DisableSchema>;
      const updated: SkillCatalogRecord = { ...record, enabled: false, status: "DISABLED", lastUpdated: new Date().toISOString() };
      await skillStore.save(updated);
      await publishSkillEvent(
        req,
        EVENT_TYPES.SKILL_DISABLED,
        { skillKey: updated.key, reason: body.reason ?? null },
        updated.key,
        "skill.disable",
      );
      res.json({ data: { skill: toCard(updated) }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

skillRouter.delete(
  "/:key",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = req.params.key as string;
      if (!(await skillStore.remove(key))) {
        res.status(404).json({ message: "Unknown skill", correlationId: getCorrelationId(req) });
        return;
      }
      await publishSkillEvent(req, EVENT_TYPES.SKILL_REMOVED, { skillKey: key }, key, "skill.remove");
      res.json({ data: { removed: key }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Assignment to agents --------------------------------------------------------

const AssignSchema = z.object({
  agentId: z.string().min(1),
  approvalRequestId: z.string().min(1).optional(),
});

skillRouter.post(
  "/:key/assign",
  requirePermission(PERMISSIONS.AGENT_MODIFY),
  validate("body", AssignSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = req.params.key as string;
      const body = req.body as unknown as z.infer<typeof AssignSchema>;
      const record = await skillStore.get(key);
      if (record === undefined) {
        res.status(404).json({ message: "Unknown skill", correlationId: getCorrelationId(req) });
        return;
      }
      const agent = await prisma.agent.findUnique({ where: { id: body.agentId } });
      if (agent === null) {
        res.status(404).json({ message: "Unknown agent", correlationId: getCorrelationId(req) });
        return;
      }
      const role = roleProfiles.has(agent.roleKey) ? roleProfiles.get(agent.roleKey) : null;
      const verdict = checkAssignmentCompatibility({
        roleKey: agent.roleKey,
        roleCapabilities: role?.capabilities ?? [],
        rolePermissions: role?.permissions.slice() ?? [],
        skill: record,
      });
      if (!verdict.compatible) {
        const ctx = actorCtx(req);
        await recordActivity(prisma, {
          actor: ctx.actor,
          action: "skill.assign",
          targetType: "Skill",
          targetId: key,
          result: "ERROR",
          error: verdict.reasons.join("; "),
          correlationId: ctx.correlationId,
          userId: ctx.userId,
          metadata: { skillKey: key, agentId: body.agentId },
        });
        res.status(409).json({ message: "Skill is not compatible with this agent", reasons: verdict.reasons, correlationId: getCorrelationId(req) });
        return;
      }
      let approvalId: string | null = null;
      if (record.risk === "HIGH" || record.risk === "CRITICAL") {
        try {
          approvalId = await claimApproval(body.approvalRequestId, "skill.assign", (payload) =>
            payload.skillKey === key && payload.agentId === body.agentId,
          );
        } catch {
          const ctx = actorCtx(req);
          const approval = await requestApproval(
            prisma,
            {
              action: "skill.assign",
              actionPayload: { skillKey: key, agentId: body.agentId },
              reason: `Assigning ${record.risk}-risk skill '${key}' to agent '${body.agentId}' requires human approval.`,
              risk: record.risk,
              requester: ctx.actor,
              requesterAgentId: null,
            },
            { actor: ctx.actor, correlationId: ctx.correlationId, userId: ctx.userId },
          );
          res.status(202).json({ data: { status: "APPROVAL_REQUIRED", approvalRequestId: approval.id }, correlationId: getCorrelationId(req) });
          return;
        }
      }
      // Assigning is not executing: usage counters are left alone (they used
      // to record a fake successful execution here, inflating reputation).
      // A repeated assign is idempotent and does not re-emit the event.
      const created = await underApproval(approvalId, () => skillStore.assign(key, body.agentId));
      if (created) {
        await publishSkillEvent(req, EVENT_TYPES.SKILL_ASSIGNED, { skillKey: key, agentId: body.agentId }, key, "skill.assign");
      }
      res.json({
        data: { skillKey: key, agentId: body.agentId, agents: await skillStore.agentsForSkill(key), alreadyAssigned: !created },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

// -- Agent skill requests (agents can request, never approve) --------------------

const RequestSchema = z.object({
  skillKey: z.string().min(1).max(120),
  agentId: z.string().min(1),
  reason: z.string().min(1).max(2000),
});

skillRouter.post(
  "/requests",
  requirePermission(PERMISSIONS.TASK_CREATE),
  validate("body", RequestSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as unknown as z.infer<typeof RequestSchema>;
      const { id } = await skillStore.createRequest({ skillKey: body.skillKey, agentId: body.agentId, reason: body.reason });
      const ctx = actorCtx(req);
      const publish = eventBus.publishAndDispatch.bind(eventBus) as (
        db: typeof prisma,
        event: unknown,
      ) => Promise<unknown>;
      await publish(prisma, {
        type: EVENT_TYPES.SKILL_REQUESTED,
        actor: ctx.actor,
        correlationId: ctx.correlationId,
        targetType: "SkillRequest",
        targetId: id,
        payload: { skillKey: body.skillKey, agentId: body.agentId },
      });
      res.status(201).json({ data: { id, status: "PENDING" }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const DecideRequestSchema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]) });

skillRouter.post(
  "/requests/:id/decision",
  requirePermission(PERMISSIONS.APPROVAL_DECIDE),
  validate("body", DecideRequestSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const found = await skillStore.getRequest(req.params.id as string);
      // A request for an agent of an invisible company is answered like a missing one.
      const existing = found !== undefined && (await scoped(req, [found], (r) => ({ agentId: r.agentId }))).length > 0
        ? found
        : undefined;
      if (existing === undefined) {
        res.status(404).json({ message: "Unknown skill request", correlationId: getCorrelationId(req) });
        return;
      }
      const body = req.body as unknown as z.infer<typeof DecideRequestSchema>;
      const ctx = actorCtx(req);
      let decided: ReturnType<typeof decideSkillRequest>;
      try {
        decided = decideSkillRequest(existing, body.decision, { userId: ctx.userId, isAgent: false });
      } catch (decisionError) {
        res.status(409).json({ message: decisionError instanceof Error ? decisionError.message : "Request already decided", correlationId: getCorrelationId(req) });
        return;
      }
      if (!(await skillStore.saveDecision(decided))) {
        res.status(409).json({ message: "Skill request was already decided", correlationId: getCorrelationId(req) });
        return;
      }
      await recordActivity(prisma, {
        actor: ctx.actor,
        action: "skill.request.decide",
        targetType: "SkillRequest",
        targetId: decided.id,
        correlationId: ctx.correlationId,
        userId: ctx.userId,
        metadata: { skillKey: decided.skillKey, decision: body.decision },
      });
      res.json({ data: decided, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Usage + reputation + lockfile + integrity ------------------------------------

skillRouter.get(
  "/:key/usage",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = req.params.key as string;
      // Agent ids of companies the caller cannot see are left out of both lists.
      const visibleAgents = async (ids: string[]): Promise<string[]> => scoped(req, ids, (agentId) => ({ agentId }));
      const usage = await skillStore.usage(key);
      const counters = { ...usage, agents: await visibleAgents(usage.agents) };
      const record = await skillStore.get(key);
      const reputation = buildReputation({
        counters,
        verified: record?.trust === "VERIFIED" || record?.trust === "SYSTEM",
        publisher: record?.author ?? null,
        lastReviewed: record?.lastUpdated ?? null,
      });
      res.json({ data: { counters, reputation, agents: await visibleAgents(await skillStore.agentsForSkill(key)) }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

skillRouter.get(
  "/state/lockfile",
  requirePermission(PERMISSIONS.AGENT_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const lock = buildLockfile(
        (await skillStore.list()).filter((r) => r.installed).map((r) => ({
          key: r.key,
          source: r.source.type,
          sourceIdentifier: r.source.identifier,
          version: r.installedVersion ?? "0.0.0",
          integrity: r.integrityHash ?? createHash("sha256").update(r.key).digest("hex"),
          dependencies: r.manifest?.dependencies.map((d) => d.key) ?? [],
          permissions: r.grantedPermissions,
          capabilities: r.manifest?.capabilities ?? [],
          installedAt: r.lastUpdated ?? new Date().toISOString(),
        })),
      );
      res.json({ data: lock, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const VerifyLockSchema = z.object({ lock: z.unknown() });

skillRouter.post(
  "/state/verify-lock",
  requirePermission(PERMISSIONS.AGENT_READ),
  validate("body", VerifyLockSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as unknown as z.infer<typeof VerifyLockSchema>;
      const lock = parseLockfile(body.lock);
      const live = new Map<string, { version: string; integrity: string }>();
      for (const r of await skillStore.list()) {
        if (r.installed) live.set(r.key, { version: r.installedVersion ?? "", integrity: r.integrityHash ?? "" });
      }
      const drifts = verifyLockfile(lock, live);
      res.json({ data: { drifts }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const IntegritySchema = z.object({
  manifest: z.unknown(),
  files: z.record(z.string(), z.string()).optional(),
  expected: z.string().min(1).max(128),
});

skillRouter.post(
  "/state/verify-integrity",
  requirePermission(PERMISSIONS.AGENT_READ),
  validate("body", IntegritySchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const body = req.body as unknown as z.infer<typeof IntegritySchema>;
      const manifest = normalizeExternalSkill(body.manifest, {
        externalId: "integrity-check",
        source: { type: "LOCAL", identifier: "integrity-check" },
      });
      const ok = verifyIntegrity(body.expected, manifest, body.files ?? {});
      const computed = skillIntegrityHash(manifest, body.files ?? {});
      res.json({ data: { ok, computed }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);
