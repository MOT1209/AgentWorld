/**
 * Stable agent-id → character mapping with incremental updates.
 *
 * - Characters are created once per agent id and reused across refreshes
 *   (no duplicates, no full-scene rebuilds).
 * - A character is removed only when its id is absent from a successfully
 *   fetched dataset (confirmed removal). Callers must NOT call `sync` with
 *   an empty/failed payload — that path keeps the previous scene intact.
 * - Idle animation runs through the single shared `update` call; there is
 *   never one loop per character.
 */

import * as THREE from "three";
import { appearanceForAgentId } from "./characterAppearance.js";
import {
  buildCharacter,
  disposeCharacter,
  type BuiltCharacter,
} from "./characterFactory.js";
import type { PlacedAgent } from "./characterPlacement.js";

export interface SyncAgent {
  id: string;
  state: string;
}

export interface SyncResult {
  added: string[];
  updated: string[];
  removed: string[];
}

interface Entry {
  character: BuiltCharacter;
  targetX: number;
  targetZ: number;
  state: string;
}

export function diffIds(
  previous: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[]; kept: string[] } {
  const prevSet = new Set(previous);
  const nextSet = new Set(next);
  const added: string[] = [];
  const kept: string[] = [];
  for (const id of nextSet) {
    if (prevSet.has(id)) kept.push(id);
    else added.push(id);
  }
  const removed: string[] = [];
  for (const id of prevSet) {
    if (!nextSet.has(id)) removed.push(id);
  }
  return { added, removed, kept };
}

export type SelectionPick =
  | { kind: "agent"; agentId: string }
  | { kind: "building"; locationId: string }
  | { kind: "none" };

/**
 * Predictable overlap resolution: a character hit always wins over a
 * building behind it; a building wins over empty space.
 */
export function pickSelection(
  characterAgentId: string | null,
  buildingLocationId: string | null,
): SelectionPick {
  if (characterAgentId !== null) return { kind: "agent", agentId: characterAgentId };
  if (buildingLocationId !== null) return { kind: "building", locationId: buildingLocationId };
  return { kind: "none" };
}

const _lerpTarget = new THREE.Vector3();

/**
 * Applies one frame of idle motion. Pure arithmetic on the given parts —
 * no allocations, no listeners, no timers. Safe to call with any finite time.
 */
export function updateIdleMotion(
  parts: BuiltCharacter["parts"],
  timeSeconds: number,
  phase: number,
): void {
  const t = timeSeconds;
  const breathe = Math.sin(t * 1.4 + phase);
  const sway = Math.sin(t * 0.5 + phase);
  parts.torso.rotation.x = breathe * 0.02;
  parts.torso.rotation.y = sway * 0.06;
  parts.torso.position.y = 0.75 + breathe * 0.012;
  parts.head.rotation.y = Math.sin(t * 0.4 + phase * 1.7) * 0.28;
  parts.head.rotation.x = Math.sin(t * 0.9 + phase) * 0.05;
  parts.armL.rotation.x = breathe * 0.07;
  parts.armR.rotation.x = -breathe * 0.07;
  parts.armL.rotation.z = 0.07 + sway * 0.015;
  parts.armR.rotation.z = -0.07 + sway * 0.015;
}

export class CharacterManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly parent: THREE.Group) {}

  get size(): number {
    return this.entries.size;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  get(agentId: string): BuiltCharacter | undefined {
    return this.entries.get(agentId)?.character;
  }

  /**
   * Reconciles the scene with the latest authoritative agent list.
   * `placements` must cover every agent (see placeAgents); entries missing
   * a placement keep their current spot.
   */
  sync(agents: readonly SyncAgent[], placements: ReadonlyMap<string, PlacedAgent>): SyncResult {
    const seen = new Set<string>();
    const added: string[] = [];
    const updated: string[] = [];

    for (const agent of agents) {
      if (seen.has(agent.id)) continue; // duplicate prevention
      seen.add(agent.id);
      const existing = this.entries.get(agent.id);
      const placement = placements.get(agent.id);
      if (existing === undefined) {
        const character = buildCharacter(agent.id, appearanceForAgentId(agent.id), agent.state);
        if (placement !== undefined) {
          character.group.position.set(placement.x, 0, placement.z);
          character.group.rotation.y = placement.yaw;
        }
        this.parent.add(character.group);
        this.entries.set(agent.id, {
          character,
          targetX: placement?.x ?? character.group.position.x,
          targetZ: placement?.z ?? character.group.position.z,
          state: agent.state,
        });
        added.push(agent.id);
      } else {
        if (existing.state !== agent.state) {
          existing.character.setStateColor(agent.state);
          existing.state = agent.state;
        }
        if (placement !== undefined) {
          existing.targetX = placement.x;
          existing.targetZ = placement.z;
          existing.character.group.rotation.y = placement.yaw;
        }
        updated.push(agent.id);
      }
    }

    const removed: string[] = [];
    for (const id of this.entries.keys()) {
      if (!seen.has(id)) {
        const entry = this.entries.get(id);
        if (entry !== undefined) disposeCharacter(entry.character.group);
        this.entries.delete(id);
        removed.push(id);
      }
    }
    return { added, updated, removed };
  }

  /** Advances movement easing + idle animation for all characters. */
  update(deltaSeconds: number, timeSeconds: number): void {
    const step = Math.min(1, Math.max(0, deltaSeconds * 4));
    for (const entry of this.entries.values()) {
      const pos = entry.character.group.position;
      _lerpTarget.set(entry.targetX, 0, entry.targetZ);
      pos.lerp(_lerpTarget, step);
      pos.y = 0; // feet stay glued to the ground plane
      updateIdleMotion(entry.character.parts, timeSeconds, entry.character.appearance.phase);
      entry.character.parts.badge.rotation.y = timeSeconds * 0.8;
    }
  }

  setHighlight(agentId: string, mode: "none" | "hover" | "selected"): void {
    this.entries.get(agentId)?.character.setHighlight(mode);
  }

  clear(): void {
    for (const entry of this.entries.values()) disposeCharacter(entry.character.group);
    this.entries.clear();
  }
}
