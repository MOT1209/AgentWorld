/**
 * Event bus.
 *
 * Two responsibilities, deliberately separated:
 *
 *   persist() - appends to EventLog inside the caller's transaction, so an
 *               event and the state change that caused it commit or roll back
 *               together. A task that fails to complete must not leave behind
 *               a TASK_COMPLETED event.
 *   subscribe - in-process fan-out for projections and reactive behaviour
 *               (live dashboard, world reactions in Phase 2).
 *
 * Subscriber failures are isolated: a broken listener can never prevent an
 * event from being recorded, and can never abort the transaction that emitted
 * it. Listeners are invoked after persistence and their errors are logged.
 */
import { newCorrelationId, toJson, logger, type ActorRef, type Severity } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import type { EventLog } from "../../database/src/types.js";
import type { EventPayloadMap, EventType } from "./catalog.js";

export interface DomainEvent<T extends EventType = EventType> {
  type: T;
  actor: ActorRef;
  payload: EventPayloadMap[T];
  correlationId?: string;
  targetType?: string;
  targetId?: string;
  worldId?: string;
  cityId?: string;
  companyId?: string;
  severity?: Severity;
}

export type EventHandler = (event: PersistedEvent) => void | Promise<void>;

export interface PersistedEvent {
  id: number;
  type: string;
  severity: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  worldId: string | null;
  cityId: string | null;
  companyId: string | null;
  payload: Record<string, unknown>;
  correlationId: string;
  createdAt: Date;
}

export type Unsubscribe = () => void;

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private log = logger.child({ component: "events" });

  /** Subscribes to one event type, or to "*" for the whole stream. */
  subscribe(type: EventType | "*", handler: EventHandler): Unsubscribe {
    const key = type;
    const set = this.handlers.get(key) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(key, set);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * Appends the event to EventLog using the supplied client.
   *
   * Pass the same transaction client as the surrounding write so the event
   * commits atomically with it. Omit `tx` only for standalone events.
   */
  async publish<T extends EventType>(
    db: DbClient,
    event: DomainEvent<T>,
  ): Promise<EventLog> {
    return db.eventLog.create({
      data: {
        type: event.type,
        severity: event.severity ?? "INFO",
        actorType: event.actor.actorType,
        actorId: event.actor.actorId ?? null,
        actorName: event.actor.actorName ?? null,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        worldId: event.worldId ?? null,
        cityId: event.cityId ?? null,
        companyId: event.companyId ?? null,
        payload: toJson(event.payload ?? {}),
        correlationId: event.correlationId ?? newCorrelationId(),
      },
    });
  }

  /**
   * Publishes and then fans out. Fan-out is deferred to a microtask so the
   * emitting transaction is not held open by a slow listener, and is always
   * failure-isolated.
   */
  async publishAndDispatch<T extends EventType>(
    db: DbClient,
    event: DomainEvent<T>,
  ): Promise<EventLog> {
    const row = await this.publish(db, event);
    this.dispatch(toPersistedEvent(row));
    return row;
  }

  private dispatch(event: PersistedEvent): void {
    const direct = this.handlers.get(event.type);
    const wildcard = this.handlers.get("*");
    for (const handler of [...(direct ?? []), ...(wildcard ?? [])]) {
      void Promise.resolve()
        .then(() => handler(event))
        .catch((error: unknown) => {
          this.log.error("Event handler failed", {
            action: "event.handler_failed",
            targetType: "EventLog",
            targetId: String(event.id),
            result: "ERROR",
            error,
            eventType: event.type,
            correlationId: event.correlationId,
          });
        });
    }
  }

  /** Number of registered handlers. Exposed for diagnostics and leak tests. */
  subscriberCount(type?: EventType | "*"): number {
    if (type === undefined) {
      let total = 0;
      for (const set of this.handlers.values()) total += set.size;
      return total;
    }
    return this.handlers.get(type)?.size ?? 0;
  }
}

export function toPersistedEvent(row: EventLog): PersistedEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    targetType: row.targetType,
    targetId: row.targetId,
    worldId: row.worldId,
    cityId: row.cityId,
    companyId: row.companyId,
    payload,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
  };
}

/** Process-wide bus. Handlers are per-process by definition. */
export const eventBus = new EventBus();
