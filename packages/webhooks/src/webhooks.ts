/**
 * Webhook system -- the outbound face of the event bus.
 *
 * Design:
 *  - Subscriptions live in `WebhookSubscription` with an event filter
 *    (JSON string[] or ["*"]). The HMAC signing secret is vault-sealed, never
 *    returned by any DTO.
 *  - Every domain event that matches a subscription creates a
 *    `WebhookDelivery` row containing the exact signed payload. Deliveries
 *    are retried with bounded exponential backoff; exhausting the budget
 *    dead-letters the delivery (never silent loss) and repeated dead letters
 *    auto-disable the subscription.
 *  - Signatures are HMAC-SHA256 over `${timestamp}.${body}` sent as
 *    `X-AgentWorld-Signature` together with `X-AgentWorld-Timestamp`, so a
 *    receiver can reject replays.
 *  - Subscription management (create/pause/resume/delete) is
 *    ALWAYS_APPROVE (`webhook.subscribe`) -- widening outbound reach is a
 *    human decision, enforced through the approval flow.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { DbClient } from "../../database/src/index.js";
import type { WebhookDelivery, WebhookSubscription } from "../../database/src/types.js";
import { eventBus, EVENT_TYPES, type PersistedEvent } from "../../events/src/index.js";
import { getConfig, logger, newCorrelationId, SYSTEM_ACTOR, toJson, validationError } from "../../shared/src/index.js";
import { open as vaultOpen, seal } from "../../vault/src/index.js";

const log = logger.child({ component: "webhooks" });

export const SIGNATURE_HEADER = "x-agentworld-signature";
export const TIMESTAMP_HEADER = "x-agentworld-timestamp";

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export interface CreateSubscriptionInput {
  url: string;
  events: string[];
  description?: string | null;
  companyId?: string | null;
}

export interface SubscriptionContext {
  actor: { actorType: "USER" | "AGENT" | "SYSTEM"; actorId?: string; actorName?: string };
  correlationId?: string;
}

function validateUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw validationError("Webhook URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw validationError("Webhook URL must use http or https");
  }
  // Loopback and link-local targets are refused in production: a webhook must
  // not be able to reach the API's own database-backed endpoints or cloud
  // metadata services. Development/test allows loopback so integrations can be
  // exercised against a local receiver.
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "169.254.169.254" ||
    host.endsWith(".local");
  if (isLoopback && getConfig().isProduction) {
    throw validationError("Webhook URL must not target loopback or link-local addresses");
  }
  return parsed.toString();
}

export async function createSubscription(
  db: DbClient,
  input: CreateSubscriptionInput,
  ctx: SubscriptionContext,
): Promise<{ subscription: WebhookSubscription; secret: string }> {
  const url = validateUrl(input.url);
  const events = input.events.length > 0 ? input.events : ["*"];
  const secret = `whsec_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  const sealed = seal(secret);
  const row = await db.webhookSubscription.create({
    data: {
      url,
      events: toJson(events),
      description: input.description ?? null,
      companyId: input.companyId ?? null,
      status: "ACTIVE",
      secretPayload: sealed.payload,
      keyVersion: sealed.keyVersion,
    },
  });
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WEBHOOK_SUBSCRIBED,
    actor: ctx.actor ?? SYSTEM_ACTOR,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "WebhookSubscription",
    targetId: row.id,
    payload: { subscriptionId: row.id, events },
  });
  // The secret is returned exactly once, here, never stored in plaintext.
  return { subscription: row, secret };
}

export async function listSubscriptions(db: DbClient): Promise<WebhookSubscription[]> {
  return db.webhookSubscription.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
}

export async function setSubscriptionStatus(
  db: DbClient,
  id: string,
  status: "ACTIVE" | "PAUSED" | "DISABLED",
): Promise<WebhookSubscription> {
  return db.webhookSubscription.update({ where: { id }, data: { status } });
}

export async function deleteSubscription(db: DbClient, id: string, ctx: SubscriptionContext): Promise<void> {
  await db.webhookSubscription.delete({ where: { id } });
  await eventBus.publishAndDispatch(db, {
    type: EVENT_TYPES.WEBHOOK_UNSUBSCRIBED,
    actor: ctx.actor ?? SYSTEM_ACTOR,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    targetType: "WebhookSubscription",
    targetId: id,
    payload: { subscriptionId: id },
  });
}

function matchesFilter(subscription: WebhookSubscription, eventType: string): boolean {
  let events: string[] = [];
  try {
    const parsed = JSON.parse(subscription.events) as unknown;
    if (Array.isArray(parsed)) events = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    events = [];
  }
  if (events.includes("*")) return true;
  if (events.includes(eventType)) return true;
  // Prefix families: "TASK_" subscribes a receiver to every task event.
  return events.some((entry) => entry.endsWith("_") && eventType.startsWith(entry));
}

/** Event-bus hook: enqueue a delivery for every matching subscription. */
export async function enqueueDeliveriesForEvent(db: DbClient, event: PersistedEvent): Promise<number> {
  if (getConfig().webhooks.enabled !== true) return 0;
  const subscriptions = await db.webhookSubscription.findMany({ where: { status: "ACTIVE" } });
  const matching = subscriptions.filter((subscription) => matchesFilter(subscription, event.type));
  if (matching.length === 0) return 0;

  const body = toJson({
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    actor: { actorType: event.actorType, actorId: event.actorId, actorName: event.actorName },
    payload: event.payload,
    correlationId: event.correlationId,
  });

  let created = 0;
  for (const subscription of matching) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    let signature = "";
    try {
      const secret = vaultOpen(subscription.secretPayload);
      signature = signPayload(secret, timestamp, body);
    } catch (error) {
      log.warn("Webhook secret unreadable; delivery skipped", {
        action: "webhook.secret_failed",
        result: "ERROR",
        error: error instanceof Error ? error.message : String(error),
        subscriptionId: subscription.id,
      });
      continue;
    }
    await db.webhookDelivery.create({
      data: {
        subscriptionId: subscription.id,
        eventType: event.type,
        payload: toJson({ timestamp, body }),
        signature,
        status: "PENDING",
        maxAttempts: getConfig().webhooks.maxAttempts,
        nextAttemptAt: new Date(),
      },
    });
    created += 1;
  }
  return created;
}

const BACKOFF_BASE_MS = 2_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** A subscription dies after this many consecutive dead-letted deliveries. */
const AUTO_DISABLE_AFTER_FAILURES = 10;

export interface DispatchOutcome {
  attempted: number;
  delivered: number;
  deadLettered: number;
  retried: number;
}

async function postWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number | null; snippet: string | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    return {
      status: response.status,
      snippet: text.slice(0, 200) || null,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: null,
      snippet: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delivery sweep: claims due PENDING deliveries and posts them. Called from a
 * short interval in main.ts -- never blocks the simulation tick (bounded batch).
 */
export async function dispatchDueDeliveries(db: DbClient, limit = 10): Promise<DispatchOutcome> {
  const outcome: DispatchOutcome = { attempted: 0, delivered: 0, deadLettered: 0, retried: 0 };
  if (getConfig().webhooks.enabled !== true) return outcome;

  const due = await db.webhookDelivery.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });

  for (const delivery of due) {
    const subscription = await db.webhookSubscription.findUnique({
      where: { id: delivery.subscriptionId },
    });
    if (subscription === null || subscription.status !== "ACTIVE") {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "DEAD", error: "Subscription inactive or removed" },
      });
      continue;
    }

    let timestamp = "";
    let body = "";
    try {
      const parsed = JSON.parse(delivery.payload) as { timestamp?: string; body?: string };
      timestamp = parsed.timestamp ?? "";
      body = parsed.body ?? "";
    } catch {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "DEAD", error: "Delivery payload corrupt" },
      });
      continue;
    }

    outcome.attempted += 1;
    const attempt = delivery.attempts + 1;
    const response = await postWebhook(
      subscription.url,
      {
        [SIGNATURE_HEADER]: `sha256=${delivery.signature}`,
        [TIMESTAMP_HEADER]: timestamp,
        "x-agentworld-delivery": delivery.id,
        "x-agentworld-event": delivery.eventType,
      },
      body,
      getConfig().webhooks.timeoutMs,
    );

    const success = response.error === null && response.status !== null && response.status >= 200 && response.status < 300;
    if (success) {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "DELIVERED",
          attempts: attempt,
          responseStatus: response.status,
          responseSnippet: response.snippet,
          error: null,
          deliveredAt: new Date(),
        },
      });
      await db.webhookSubscription.update({
        where: { id: subscription.id },
        data: { failureCount: 0, lastDeliveryAt: new Date() },
      });
      outcome.delivered += 1;
      await eventBus
        .publishAndDispatch(db, {
          type: EVENT_TYPES.WEBHOOK_DELIVERED,
          actor: SYSTEM_ACTOR,
          correlationId: newCorrelationId(),
          targetType: "WebhookDelivery",
          targetId: delivery.id,
          payload: {
            deliveryId: delivery.id,
            subscriptionId: subscription.id,
            eventType: delivery.eventType,
            attempts: attempt,
          },
        })
        .catch(() => undefined);
      continue;
    }

    if (attempt >= delivery.maxAttempts) {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "DEAD",
          attempts: attempt,
          responseStatus: response.status,
          responseSnippet: response.snippet,
          error: response.error ?? `HTTP ${response.status ?? "?"}`,
        },
      });
      const failureCount = subscription.failureCount + 1;
      await db.webhookSubscription.update({
        where: { id: subscription.id },
        data: {
          failureCount,
          lastDeliveryAt: new Date(),
          ...(failureCount >= AUTO_DISABLE_AFTER_FAILURES ? { status: "DISABLED" } : {}),
        },
      });
      outcome.deadLettered += 1;
      await eventBus
        .publishAndDispatch(db, {
          type: EVENT_TYPES.WEBHOOK_DEAD_LETTERED,
          actor: SYSTEM_ACTOR,
          correlationId: newCorrelationId(),
          targetType: "WebhookDelivery",
          targetId: delivery.id,
          payload: { deliveryId: delivery.id, subscriptionId: subscription.id, attempts: attempt },
        })
        .catch(() => undefined);
      continue;
    }

    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: attempt,
        responseStatus: response.status,
        responseSnippet: response.snippet,
        error: response.error ?? `HTTP ${response.status ?? "?"}`,
        nextAttemptAt: new Date(Date.now() + backoff),
      },
    });
    outcome.retried += 1;
    await eventBus
      .publishAndDispatch(db, {
        type: EVENT_TYPES.WEBHOOK_DELIVERY_FAILED,
        actor: SYSTEM_ACTOR,
        correlationId: newCorrelationId(),
        targetType: "WebhookDelivery",
        targetId: delivery.id,
        payload: {
          deliveryId: delivery.id,
          subscriptionId: subscription.id,
          attempt,
          error: response.error,
        },
      })
      .catch(() => undefined);
  }

  return outcome;
}

export function startWebhookDispatcher(
  db: DbClient,
  options: { intervalMs?: number } = {},
): { stop(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 2_000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await dispatchDueDeliveries(db);
      } catch (error) {
        log.warn("Webhook dispatch sweep failed", {
          action: "webhook.sweep_failed",
          result: "ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, intervalMs);
      });
    }
  };
  inFlight = loop();
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await inFlight;
    },
  };
}

/** Delivery log for a subscription (metadata only, no payload bodies). */
export async function listDeliveries(db: DbClient, subscriptionId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.webhookDelivery.findMany({
    where: { subscriptionId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(deliverySummary);
}

export function deliverySummary(delivery: WebhookDelivery): Record<string, unknown> {
  return {
    id: delivery.id,
    subscriptionId: delivery.subscriptionId,
    eventType: delivery.eventType,
    status: delivery.status,
    attempts: delivery.attempts,
    maxAttempts: delivery.maxAttempts,
    responseStatus: delivery.responseStatus,
    error: delivery.error,
    deliveredAt: delivery.deliveredAt,
    createdAt: delivery.createdAt,
  };
}
