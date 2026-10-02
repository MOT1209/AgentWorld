/**
 * Permission review + capability down-scoping.
 *
 * Installation is NOT authorization: installing makes a skill available,
 * it never grants execution rights. This module computes
 * requested-vs-allowed and enforces that an install may only REDUCE
 * authority (allowed ⊆ requested). Expansion is always rejected.
 */
import { HUMAN_ONLY_PERMISSIONS } from "./security-analyzer.js";

export interface PermissionReview {
  requested: string[];
  allowed: string[];
  denied: string[];
  /** Dangerous or human-only entries that need an explicit human decision. */
  requiresExplicitApproval: string[];
  widened: string[];
}

export function reviewPermissions(requested: string[], allowedRequested: string[] | null): PermissionReview {
  const normalized = [...new Set(requested.map((p) => p.trim()).filter((p) => p !== ""))];
  const allowed =
    allowedRequested === null
      ? normalized.filter((p) => !(HUMAN_ONLY_PERMISSIONS as readonly string[]).includes(p))
      : [...new Set(allowedRequested)];
  const widened = allowed.filter((p) => !normalized.includes(p) && normalized.includes("*") !== true);
  const denied = normalized.filter((p) => !allowed.includes(p));
  // A wildcard request down-scoped to explicit allows is a reduction, not a widening.
  const effectiveWidened = normalized.includes("*") ? [] : widened;
  const requiresExplicitApproval = normalized.filter((p) =>
    (HUMAN_ONLY_PERMISSIONS as readonly string[]).includes(p),
  );
  return { requested: normalized, allowed, denied, requiresExplicitApproval, widened: effectiveWidened };
}

export function assertDownScope(review: PermissionReview): void {
  if (review.widened.length > 0) {
    throw new Error(`Install may not widen permissions beyond requested: ${review.widened.join(", ")}`);
  }
}

/** Capability down-scoping follows the same subset rule. */
export function downScopeCapabilities(requested: string[], allowed: string[] | null): { allowed: string[]; denied: string[] } {
  if (allowed === null) return { allowed: [...requested], denied: [] };
  const allowSet = new Set(allowed);
  return {
    allowed: requested.filter((c) => allowSet.has(c)),
    denied: requested.filter((c) => !allowSet.has(c)),
  };
}
