import { randomUUID } from "node:crypto";

/**
 * Correlation ids stitch together one logical operation across the HTTP
 * request, the agent loop, every tool invocation, the ledger rows it writes and
 * the events it emits. Without it, an incident in the activity timeline cannot
 * be traced to the tool call that caused it.
 */
export function newCorrelationId(): string {
  return randomUUID();
}

/** Accepts an inbound id only if it looks sane; otherwise mints a fresh one. */
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function normaliseCorrelationId(incoming: unknown): string {
  if (typeof incoming === "string" && SAFE_ID.test(incoming)) return incoming;
  return newCorrelationId();
}
