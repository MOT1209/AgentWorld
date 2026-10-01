/**
 * Role hierarchy.
 *
 * Delegation and escalation need to know, purely structurally, who may hand
 * work to whom and where a blocked task goes next. That graph lives on the
 * RoleProfile (`capabilities` + `reportsTo`); this module contains only pure
 * functions over it.
 *
 * Design rules:
 *
 *  - No names. Ahmad/Rashid are instances; PLANNER/EXECUTOR are roles. Every
 *    function here takes roleKeys, never agent names.
 *  - `reportsTo` absent means the role escalates straight to a human. That is
 *    the root of the tree (the PLANNER role).
 *  - Cycles are rejected at registration time by `assertAcyclic`, so every
 *    read-side walk below can assume termination.
 */
import type { TaskType } from "../../shared/src/index.js";
import type { Capability } from "./capabilities.js";
import { agentCanHandleTaskType } from "./capabilities.js";

export interface HierarchyNode {
  roleKey: string;
  /** RoleKey that receives this role's escalations. Absent = human. */
  reportsTo?: string;
  capabilities: readonly Capability[];
}

/** roleKey -> node, for graph walks. */
export type HierarchyGraph = ReadonlyMap<string, HierarchyNode>;

export function buildGraph(nodes: readonly HierarchyNode[]): HierarchyGraph {
  return new Map(nodes.map((node) => [node.roleKey, node]));
}

/**
 * Roles from `fromRoleKey` up to the root, inclusive. E.g. EXECUTOR ->
 * ["EXECUTOR", "PLANNER"].
 */
export function escalationChain(graph: HierarchyGraph, fromRoleKey: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = fromRoleKey;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = graph.get(current)?.reportsTo;
  }
  return chain;
}

/** True when `ancestor` sits on the escalation chain above `descendant`. */
export function isAncestor(
  graph: HierarchyGraph,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return false;
  return escalationChain(graph, descendant).includes(ancestor);
}

/**
 * Nearest supervisor of `fromRoleKey` that can accept work of `taskType`.
 * Walks the escalation chain; undefined when nobody up the tree can, which is
 * an escalation-to-human signal, not an error.
 */
export function nearestCapableSupervisor(
  graph: HierarchyGraph,
  fromRoleKey: string,
  taskType: TaskType,
): string | undefined {
  for (const roleKey of escalationChain(graph, fromRoleKey).slice(1)) {
    const node = graph.get(roleKey);
    if (node && agentCanHandleTaskType(node.capabilities, taskType)) return roleKey;
  }
  return undefined;
}

/** Roles qualified to be assigned a task of this type (no ordering implied). */
export function capableRoles(graph: HierarchyGraph, taskType: TaskType): string[] {
  return [...graph.values()]
    .filter((node) => agentCanHandleTaskType(node.capabilities, taskType))
    .map((node) => node.roleKey);
}

/**
 * Registration guard: no role may reach itself by following `reportsTo`.
 * Returns the offending cycle as a readable path when one exists.
 */
export function findCycle(graph: HierarchyGraph): string[] | undefined {
  for (const start of graph.keys()) {
    const seen = new Set<string>();
    const path: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined) {
      if (path.includes(current)) {
        return [...path.slice(path.indexOf(current)), current];
      }
      if (seen.has(current)) break;
      seen.add(current);
      path.push(current);
      current = graph.get(current)?.reportsTo;
    }
  }
  return undefined;
}

export function assertAcyclic(graph: HierarchyGraph): void {
  const cycle = findCycle(graph);
  if (cycle !== undefined) {
    throw new Error(`Role hierarchy contains a cycle: ${cycle.join(" -> ")}`);
  }
}
