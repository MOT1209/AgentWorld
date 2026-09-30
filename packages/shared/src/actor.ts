import type { ActorType } from "./enums.js";

/**
 * Who is performing an operation.
 *
 * Deliberately a plain type with no persistence coupling: every service, event
 * and ledger entry carries one, and it must be constructible from any layer
 * without importing the ORM.
 */
export interface ActorRef {
  actorType: ActorType;
  actorId?: string;
  actorName?: string;
}

export const SYSTEM_ACTOR: ActorRef = {
  actorType: "SYSTEM",
  actorName: "system",
};

export function actorUser(id: string, name?: string): ActorRef {
  return { actorType: "USER", actorId: id, ...(name !== undefined ? { actorName: name } : {}) };
}

export function actorAgent(id: string, name?: string): ActorRef {
  return { actorType: "AGENT", actorId: id, ...(name !== undefined ? { actorName: name } : {}) };
}

export function actorSystem(name = "system"): ActorRef {
  return { actorType: "SYSTEM", actorName: name };
}

/** Stable label for audit rows when no id is known. */
export function actorLabel(actor: ActorRef): string {
  return actor.actorName ?? actor.actorId ?? actor.actorType.toLowerCase();
}
