/**
 * Integrations REST surface (/api/v1/integrations/*).
 *
 * Covers: AI provider gateway status + models, credential management
 * (owner-only), connector marketplace + credential binding, webhook
 * subscriptions, API keys, and the OAuth callback. MCP has its own route file.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import { getPrincipal, authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { validate } from "../middleware/validate.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { principalToActor } from "../../../../packages/security/src/rbac.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { getProviderRegistry, modelRegistry, usageSummary, describeVendorCatalog } from "../../../../packages/ai/src/index.js";
import {
  createCredential,
  listCredentials,
  credentialMetadata,
  rotateCredential,
  revokeCredential,
} from "../../../../packages/vault/src/index.js";
import {
  marketplaceCatalog,
  getDescriptor,
  beginAuthorization,
  completeAuthorization,
} from "../../../../packages/connectors/src/index.js";
import {
  createSubscription,
  listSubscriptions,
  setSubscriptionStatus,
  deleteSubscription,
  listDeliveries,
} from "../../../../packages/webhooks/src/index.js";
import {
  createApiKey,
  revokeApiKey,
  listApiKeys,
  apiKeyMetadata,
} from "../../../../packages/security/src/api-keys.js";
import { validationError } from "../../../../packages/shared/src/index.js";

export const integrationsRouter: Router = Router();
integrationsRouter.use(authenticate);

// -- AI providers -------------------------------------------------------------

integrationsRouter.get(
  "/providers",
  requirePermission(PERMISSIONS.PROVIDER_READ),
  (_req: Request, res: Response): void => {
    const registry: ReturnType<typeof getProviderRegistry> = getProviderRegistry();
    const descriptors: Array<{ id: string; kind: string; configured: boolean }> = registry.list().map((d) => ({
      id: d.id,
      kind: d.kind,
      configured: d.configured,
    }));
    res.json({ data: { providers: descriptors, catalog: describeVendorCatalog() }, correlationId: getCorrelationId(_req) });
  },
);

integrationsRouter.get(
  "/models",
  requirePermission(PERMISSIONS.PROVIDER_READ),
  (req: Request, res: Response): void => {
    const q = req.query as Record<string, string | undefined>;
    const registry = getProviderRegistry();
    modelRegistry.refreshAvailability(
      new Set(registry.list().filter((d) => d.configured).map((d) => d.id)),
    );
    const models = modelRegistry.list({
      ...(q.providerId !== undefined ? { providerId: q.providerId } : {}),
      ...(q.capability !== undefined ? { capabilities: [q.capability] } : {}),
      ...(q.available === "true" ? {} : {}),
    });
    res.json({
      data: {
        models: models.map((model) => ({
          providerId: model.providerId,
          modelId: model.modelId,
          displayName: model.displayName,
          capabilities: model.capabilities,
          contextWindow: model.contextWindow,
          available: model.available,
        })),
      },
      correlationId: getCorrelationId(req),
    });
  },
);

integrationsRouter.get(
  "/ai-usage",
  requirePermission(PERMISSIONS.PROVIDER_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const summary = await usageSummary(prisma, {
        ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
      });
      res.json({ data: summary, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Credentials (owner-only: widening external reach is always a human call) --

const CreateCredentialSchema = z.object({
  name: z.string().min(2).max(120),
  scope: z.enum(["PROVIDER", "CONNECTOR"]),
  refId: z.string().min(1).max(80),
  secret: z.string().min(1).max(4_000),
  kind: z.enum(["API_KEY", "OAUTH", "TOKEN", "CUSTOM"]).default("API_KEY"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

integrationsRouter.post(
  "/credentials",
  requirePermission(PERMISSIONS.CREDENTIAL_MANAGE),
  validate("body", CreateCredentialSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateCredentialSchema>;
      const row = await createCredential(
        prisma,
        {
          name: body.name,
          scope: body.scope,
          refId: body.refId,
          secret: body.secret,
          kind: body.kind,
          metadata: body.metadata,
        },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
      );
      res.status(201).json({ data: credentialMetadata(row), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

integrationsRouter.get(
  "/credentials",
  requirePermission(PERMISSIONS.CREDENTIAL_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const rows = await listCredentials(prisma, q.scope);
      res.json({ data: rows.map(credentialMetadata), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

const RotateSchema = z.object({ secret: z.string().min(1).max(4_000) });

integrationsRouter.post(
  "/credentials/:id/rotate",
  requirePermission(PERMISSIONS.CREDENTIAL_MANAGE),
  validate("body", RotateSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof RotateSchema>;
      const row = await rotateCredential(prisma, req.params.id as string, body.secret, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: credentialMetadata(row), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

integrationsRouter.post(
  "/credentials/:id/revoke",
  requirePermission(PERMISSIONS.CREDENTIAL_MANAGE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const row = await revokeCredential(prisma, req.params.id as string, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: credentialMetadata(row), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Connectors ---------------------------------------------------------------

integrationsRouter.get(
  "/connectors",
  requirePermission(PERMISSIONS.CONNECTOR_READ),
  (_req: Request, res: Response): void => {
    res.json({
      data: {
        connectors: marketplaceCatalog().map((descriptor) => ({
          slug: descriptor.slug,
          displayName: descriptor.displayName,
          version: descriptor.version,
          category: descriptor.category,
          provider: descriptor.provider,
          kind: descriptor.kind,
          auth: descriptor.auth,
          description: descriptor.description,
          actions: descriptor.actions,
          capabilities: descriptor.capabilities,
          requiredScopes: descriptor.requiredScopes,
          security: descriptor.security,
          setupNotes: descriptor.setupNotes ?? null,
        })),
      },
      correlationId: getCorrelationId(_req),
    });
  },
);

integrationsRouter.get(
  "/connectors/:slug",
  requirePermission(PERMISSIONS.CONNECTOR_READ),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const descriptor = getDescriptor(req.params.slug as string);
      res.json({ data: descriptor, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- Webhooks -----------------------------------------------------------------

const SubscribeSchema = z.object({
  url: z.string().max(500),
  events: z.array(z.string().max(80)).max(30).default(["*"]),
  description: z.string().max(300).optional(),
});

integrationsRouter.post(
  "/webhooks",
  requirePermission(PERMISSIONS.WEBHOOK_MANAGE),
  validate("body", SubscribeSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof SubscribeSchema>;
      const { subscription, secret } = await createSubscription(
        prisma,
        { url: body.url, events: body.events, description: body.description ?? null },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
      );
      res.status(201).json({
        data: { subscription: { id: subscription.id, url: subscription.url, events: subscription.events, status: subscription.status }, secret },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

integrationsRouter.get(
  "/webhooks",
  requirePermission(PERMISSIONS.WEBHOOK_READ),
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rows = await listSubscriptions(prisma);
      res.json({
        data: rows.map((row) => ({
          id: row.id,
          url: row.url,
          events: row.events,
          status: row.status,
          failureCount: row.failureCount,
          lastDeliveryAt: row.lastDeliveryAt,
          createdAt: row.createdAt,
        })),
        correlationId: getCorrelationId(_req),
      });
    } catch (error) {
      next(error);
    }
  },
);

integrationsRouter.post(
  "/webhooks/:id/status",
  requirePermission(PERMISSIONS.WEBHOOK_MANAGE),
  validate("body", z.object({ status: z.enum(["ACTIVE", "PAUSED", "DISABLED"]) })),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as { status: "ACTIVE" | "PAUSED" | "DISABLED" };
      const row = await setSubscriptionStatus(prisma, req.params.id as string, body.status);
      res.json({ data: { id: row.id, status: row.status }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

integrationsRouter.get(
  "/webhooks/:id/deliveries",
  requirePermission(PERMISSIONS.WEBHOOK_READ),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deliveries = await listDeliveries(prisma, req.params.id as string);
      res.json({ data: deliveries, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

integrationsRouter.delete(
  "/webhooks/:id",
  requirePermission(PERMISSIONS.WEBHOOK_MANAGE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      await deleteSubscription(prisma, req.params.id as string, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: { ok: true }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- API keys -----------------------------------------------------------------

const CreateKeySchema = z.object({
  name: z.string().min(2).max(120),
  scopes: z.array(z.string().max(80)).min(1).max(20),
  ttlHours: z.number().int().min(1).max(8_760).optional(),
});

integrationsRouter.post(
  "/api-keys",
  requirePermission(PERMISSIONS.APIKEY_MANAGE),
  validate("body", CreateKeySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const body = req.body as z.infer<typeof CreateKeySchema>;
      const { apiKey, secret } = await createApiKey(
        prisma,
        {
          name: body.name,
          scopes: body.scopes,
          userId: principal.userId,
          ownerPermissions: principal.permissions,
          ttlHours: body.ttlHours ?? null,
        },
        { actor: principalToActor(principal), correlationId: getCorrelationId(req) },
      );
      res.status(201).json({
        data: { apiKey: apiKeyMetadata(apiKey), secret },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

integrationsRouter.get(
  "/api-keys",
  requirePermission(PERMISSIONS.APIKEY_MANAGE),
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rows = await listApiKeys(prisma);
      res.json({ data: rows.map(apiKeyMetadata), correlationId: getCorrelationId(_req) });
    } catch (error) {
      next(error);
    }
  },
);

integrationsRouter.post(
  "/api-keys/:id/revoke",
  requirePermission(PERMISSIONS.APIKEY_MANAGE),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = getPrincipal(req);
      const row = await revokeApiKey(prisma, req.params.id as string, {
        actor: principalToActor(principal),
        correlationId: getCorrelationId(req),
      });
      res.json({ data: apiKeyMetadata(row), correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// -- OAuth callback (connector flows) -----------------------------------------

integrationsRouter.get(
  "/oauth/callback",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      if (q.code === undefined || q.state === undefined) {
        throw validationError("code and state query parameters are required");
      }
      const result = await completeAuthorization(
        { code: q.code, state: q.state },
        // The callback arrives unauthenticated; the signed state is the proof
        // that the flow was started by us. A system principal records it.
        { actor: { actorType: "SYSTEM", actorName: "oauth-callback" }, db: prisma, correlationId: getCorrelationId(req) },
      );
      res.json({
        data: { ok: true, credentialId: result.credentialId, connector: result.connectorSlug },
        correlationId: getCorrelationId(req),
      });
    } catch (error) {
      next(error);
    }
  },
);

integrationsRouter.post(
  "/oauth/:slug/begin",
  requirePermission(PERMISSIONS.CREDENTIAL_MANAGE),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const principal = getPrincipal(req);
      const { authorizationUrl, state } = beginAuthorization(req.params.slug as string, {
        actor: principalToActor(principal),
        db: prisma,
        correlationId: getCorrelationId(req),
      });
      res.json({ data: { authorizationUrl, state }, correlationId: getCorrelationId(req) });
    } catch (error) {
      next(error);
    }
  },
);

// 404 for unknown sub-resources under /integrations
integrationsRouter.use((_req: Request, res: Response): void => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown integrations resource" } });
});
