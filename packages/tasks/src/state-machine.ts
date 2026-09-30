/**
 * Task lifecycle state machine.
 *
 * Encoded as an explicit transition table rather than a chain of `if`s, so the
 * set of legal moves is reviewable in one place and testable exhaustively.
 *
 * Design notes:
 *  - COMPLETED and CANCELLED are terminal. History is immutable; a mistake is
 *    corrected by a new task, not by rewriting a closed one.
 *  - FAILED is deliberately re-enterable: a task that failed once and is then
 *    retried is a normal simulation outcome, and every attempt is counted.
 *  - BLOCKED and WAITING_APPROVAL are distinct: one is a dependency, the other
 *    is a human decision. Collapsing them would hide a stalled approval behind
 *    "blocked by task #7".
 */
import { TASK_STATUSES, type TaskStatus } from "../../shared/src/index.js";

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ["PLANNED", "ASSIGNED", "BLOCKED", "CANCELLED"],
  PLANNED: ["ASSIGNED", "PENDING", "BLOCKED", "CANCELLED"],
  ASSIGNED: ["RUNNING", "BLOCKED", "WAITING_APPROVAL", "FAILED", "PENDING", "CANCELLED"],
  RUNNING: ["COMPLETED", "FAILED", "BLOCKED", "WAITING_APPROVAL", "CANCELLED"],
  WAITING_APPROVAL: ["RUNNING", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"],
  BLOCKED: ["ASSIGNED", "RUNNING", "PLANNED", "PENDING", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["PENDING", "PLANNED", "ASSIGNED", "RUNNING", "CANCELLED"],
  CANCELLED: [],
};

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["COMPLETED", "CANCELLED"];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from];
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal task transition ${from} -> ${to}. Allowed: ${TASK_TRANSITIONS[from].join(", ") || "none"}`,
    );
  }
}

export const ALL_TASK_STATUSES: readonly TaskStatus[] = TASK_STATUSES;

/** Statuses that mean an agent is currently occupied with the task. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  "ASSIGNED",
  "RUNNING",
  "WAITING_APPROVAL",
];

/** Statuses a planner hands to an executor. */
export const ASSIGNABLE_TASK_STATUSES: readonly TaskStatus[] = [
  "PENDING",
  "PLANNED",
  "BLOCKED",
  "FAILED",
];
