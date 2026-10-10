/**
 * Step 2 character system: deterministic appearance, placement, selection,
 * idle animation, factory structure, and stable id mapping.
 *
 * These modules are DOM-free on import (three.js scene graph only), so they
 * run in the Node test environment.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  appearanceForAgentId,
  stateColorHex,
  hashStringToUint32,
  SKIN_TONES,
  CLOTHING_COLORS,
  PANTS_COLORS,
  HAIR_COLORS,
  HAIRSTYLE_COUNT,
  BUILD_COUNT,
} from "../apps/web/src/world/characterAppearance.js";
import {
  placeAgents,
  clearanceForKind,
  isWalkableKind,
  FALLBACK_CENTER,
  FALLBACK_SPREAD,
  type BuildingAnchor,
} from "../apps/web/src/world/characterPlacement.js";
import {
  buildCharacter,
  findCharacterAgentId,
  sharedGeometryCount,
} from "../apps/web/src/world/characterFactory.js";
import {
  CharacterManager,
  diffIds,
  pickSelection,
  updateIdleMotion,
} from "../apps/web/src/world/characterManager.js";

describe("character appearance", () => {
  it("is deterministic per stable agent id", () => {
    const a = appearanceForAgentId("agent-abc-123");
    const b = appearanceForAgentId("agent-abc-123");
    expect(b).toEqual(a);
    expect(hashStringToUint32("agent-abc-123")).toBe(hashStringToUint32("agent-abc-123"));
  });

  it("derives identity from the id only (renames never change looks)", () => {
    // The function takes the id alone, so a rename cannot alter appearance.
    const before = appearanceForAgentId("stable-id-1");
    const after = appearanceForAgentId("stable-id-1");
    expect(after).toEqual(before);
  });

  it("varies across ids and stays within palette ranges", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const app = appearanceForAgentId(`agent-${i}-cuid`);
      seen.add(JSON.stringify(app));
      expect(SKIN_TONES).toContain(app.skin);
      expect(CLOTHING_COLORS).toContain(app.clothing);
      expect(PANTS_COLORS).toContain(app.pants);
      expect(HAIR_COLORS).toContain(app.hair);
      expect(app.hairStyle).toBeGreaterThanOrEqual(0);
      expect(app.hairStyle).toBeLessThan(HAIRSTYLE_COUNT);
      expect(app.build).toBeGreaterThanOrEqual(0);
      expect(app.build).toBeLessThan(BUILD_COUNT);
      expect(app.phase).toBeGreaterThanOrEqual(0);
      expect(app.phase).toBeLessThanOrEqual(Math.PI * 2);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("maps known states to badge colors and falls back for unknown states", () => {
    expect(stateColorHex("WORKING")).toBe(0x22c55e);
    expect(stateColorHex("IDLE")).toBe(0x94a3b8);
    expect(stateColorHex("SOMETHING_NEW")).toBe(stateColorHex("UNKNOWN"));
  });
});

describe("character placement", () => {
  const anchors = new Map<string, BuildingAnchor>([
    { locationId: "office-1", x: 20, z: 0, clearance: clearanceForKind("OFFICE") },
    { locationId: "plaza-1", x: 0, z: 0, clearance: 2.6, walkable: true },
  ].map((a) => [a.locationId, a]));
  const walkable = new Map([
    ["office-1", false],
    ["plaza-1", true],
  ]);

  it("is deterministic for the same input", () => {
    const agents = [
      { id: "a1", locationId: "office-1" },
      { id: "a2", locationId: "office-1" },
      { id: "a3", locationId: null },
    ];
    expect(placeAgents(agents, anchors, walkable)).toEqual(
      placeAgents(agents, anchors, walkable),
    );
  });

  it("does not depend on input order (no index-based slots)", () => {
    const first = placeAgents(
      [
        { id: "a1", locationId: "office-1" },
        { id: "a2", locationId: "office-1" },
      ],
      anchors,
      walkable,
    );
    const second = placeAgents(
      [
        { id: "a2", locationId: "office-1" },
        { id: "a1", locationId: "office-1" },
      ],
      anchors,
      walkable,
    );
    const byId = (rows: { agentId: string; x: number; z: number }[]): Map<string, { x: number; z: number }> =>
      new Map(rows.map((r) => [r.agentId, { x: r.x, z: r.z }]));
    expect(byId(second)).toEqual(byId(first));
  });

  it("keeps building characters outside the footprint", () => {
    const [placed] = placeAgents([{ id: "w1", locationId: "office-1" }], anchors, walkable);
    expect(placed).toBeDefined();
    const dx = (placed?.x ?? 0) - 20;
    const dz = placed?.z ?? 0;
    expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(clearanceForKind("OFFICE"));
    expect(placed?.fallback).toBe(false);
    expect(Number.isFinite(placed?.yaw ?? NaN)).toBe(true);
  });

  it("lets plaza characters stand on the walkable surface", () => {
    const [placed] = placeAgents([{ id: "p1", locationId: "plaza-1" }], anchors, walkable);
    const dist = Math.hypot((placed?.x ?? 0) - 0, (placed?.z ?? 0) - 0);
    expect(dist).toBeLessThanOrEqual(3);
  });

  it("sends missing and unknown locations to the explicit fallback", () => {
    const rows = placeAgents(
      [
        { id: "u1", locationId: null },
        { id: "u2", locationId: "no-such-location" },
      ],
      anchors,
      walkable,
    );
    for (const row of rows) {
      expect(row.fallback).toBe(true);
      expect(row.locationId).toBeNull();
      const dist = Math.hypot(row.x - FALLBACK_CENTER.x, row.z - FALLBACK_CENTER.z);
      expect(dist).toBeLessThanOrEqual(FALLBACK_SPREAD + 1.5);
    }
  });

  it("knows walkable kinds and office clearance", () => {
    expect(isWalkableKind("PLAZA")).toBe(true);
    expect(isWalkableKind("PARK")).toBe(true);
    expect(isWalkableKind("OFFICE")).toBe(false);
    expect(clearanceForKind("OFFICE")).toBeGreaterThan(clearanceForKind("HOUSE"));
  });
});

describe("id diffing and selection priority", () => {
  it("diffs added/kept/removed and dedupes", () => {
    const diff = diffIds(["a", "b"], ["b", "c", "c"]);
    expect(diff.added).toEqual(["c"]);
    expect(diff.kept).toEqual(["b"]);
    expect(diff.removed).toEqual(["a"]);
  });

  it("resolves overlapping targets predictably (character wins)", () => {
    expect(pickSelection("agent-1", "loc-1")).toEqual({ kind: "agent", agentId: "agent-1" });
    expect(pickSelection(null, "loc-1")).toEqual({ kind: "building", locationId: "loc-1" });
    expect(pickSelection(null, null)).toEqual({ kind: "none" });
  });
});

describe("idle animation", () => {
  it("stays subtle, finite, and deterministic", () => {
    const built = buildCharacter("idle-1", appearanceForAgentId("idle-1"), "IDLE");
    const seen = new Set<string>();
    for (let t = 0; t <= 10; t += 0.5) {
      updateIdleMotion(built.parts, t, built.appearance.phase);
      for (const value of [
        built.parts.torso.rotation.x,
        built.parts.torso.rotation.y,
        built.parts.head.rotation.x,
        built.parts.head.rotation.y,
        built.parts.armL.rotation.x,
        built.parts.armR.rotation.x,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.abs(value)).toBeLessThan(0.5);
      }
      expect(Math.abs(built.parts.torso.position.y - 0.75)).toBeLessThan(0.05);
      seen.add(built.parts.head.rotation.y.toFixed(4));
    }
    // It actually moves (more than one distinct pose across 10s).
    expect(seen.size).toBeGreaterThan(3);

    // Same time + phase reproduces the same pose.
    updateIdleMotion(built.parts, 3.25, built.appearance.phase);
    const first = built.parts.head.rotation.y;
    updateIdleMotion(built.parts, 3.25, built.appearance.phase);
    expect(built.parts.head.rotation.y).toBe(first);
  });
});

describe("character factory", () => {
  it("builds a recognizable human silhouette standing on the ground", () => {
    const built = buildCharacter("factory-1", appearanceForAgentId("factory-1"), "WORKING");
    // legs + shoes + upper body + badge + ring + hit proxy
    expect(built.group.children.length).toBe(8);
    expect(built.group.userData).toMatchObject({ kind: "character", agentId: "factory-1" });
    // Upper body carries torso meshes, two arms, neck, and the head group.
    expect(built.parts.torso.children.length).toBeGreaterThanOrEqual(6);
    // Head group carries skull, hair, and eyes.
    expect(built.parts.head.children.length).toBeGreaterThanOrEqual(3);

    const box = new THREE.Box3().setFromObject(built.group);
    // Feet at the ground plane.
    expect(Math.abs(box.min.y)).toBeLessThan(0.03);
    // Head top + state badge (scaled 1.35x) land in a human range for the city.
    expect(box.max.y).toBeGreaterThan(2.5);
    expect(box.max.y).toBeLessThan(3.1);
    // Upright posture: roughly as tall as wide suggests, and symmetric.
    const size = box.getSize(new THREE.Vector3());
    expect(size.y).toBeGreaterThan(size.x * 1.5);
    expect(Math.abs(box.min.x + box.max.x)).toBeLessThan(0.2);
  });

  it("shares geometries across characters and swaps state colors", () => {
    const before = sharedGeometryCount();
    const first = buildCharacter("shared-1", appearanceForAgentId("shared-1"), "IDLE");
    const afterFirst = sharedGeometryCount();
    expect(afterFirst).toBeGreaterThanOrEqual(before);
    buildCharacter("shared-2", appearanceForAgentId("shared-2"), "WORKING");
    // No new geometries for the second character.
    expect(sharedGeometryCount()).toBe(afterFirst);

    const idleMat = first.parts.badge.material;
    first.setStateColor("WORKING");
    expect(first.parts.badge.material).not.toBe(idleMat);

    first.setHighlight("selected");
    expect(first.parts.ring.visible).toBe(true);
    first.setHighlight("none");
    expect(first.parts.ring.visible).toBe(false);
  });

  it("resolves the owning agent id from any child mesh", () => {
    const built = buildCharacter("find-1", appearanceForAgentId("find-1"), "IDLE");
    const child = built.parts.torso.children[0] ?? null;
    expect(findCharacterAgentId(child)).toBe("find-1");
    expect(findCharacterAgentId(null)).toBeNull();
    expect(findCharacterAgentId(new THREE.Group())).toBeNull();
  });
});

describe("character manager", () => {
  function placementsFor(ids: string[]): Map<string, { agentId: string; locationId: string | null; x: number; z: number; yaw: number; fallback: boolean }> {
    return new Map(
      ids.map((id, i) => [
        id,
        { agentId: id, locationId: null, x: i * 2, z: i, yaw: 0, fallback: true },
      ]),
    );
  }

  it("maps ids stably, prevents duplicates, and removes on confirmed deletion", () => {
    const parent = new THREE.Group();
    const manager = new CharacterManager(parent);
    const first = manager.sync(
      [
        { id: "m1", state: "IDLE" },
        { id: "m2", state: "WORKING" },
      ],
      placementsFor(["m1", "m2"]),
    );
    expect(first.added.sort()).toEqual(["m1", "m2"]);
    expect(manager.size).toBe(2);
    expect(parent.children.length).toBe(2);

    // Refresh with a duplicate entry: still exactly one character per id.
    const second = manager.sync(
      [
        { id: "m1", state: "IDLE" },
        { id: "m1", state: "IDLE" },
        { id: "m2", state: "IDLE" },
      ],
      placementsFor(["m1", "m2"]),
    );
    expect(second.added).toEqual([]);
    expect(manager.size).toBe(2);
    expect(parent.children.length).toBe(2);
    // State updates propagate to the badge.
    const badgeMat = manager.get("m2")?.parts.badge.material;
    expect(badgeMat).toBeDefined();

    // Confirmed deletion removes exactly that character.
    const third = manager.sync([{ id: "m1", state: "IDLE" }], placementsFor(["m1"]));
    expect(third.removed).toEqual(["m2"]);
    expect(manager.size).toBe(1);
    expect(parent.children.length).toBe(1);
    expect(manager.get("m2")).toBeUndefined();

    manager.clear();
    expect(manager.size).toBe(0);
    expect(parent.children.length).toBe(0);
  });

  it("eases toward new placements without leaving the ground", () => {
    const parent = new THREE.Group();
    const manager = new CharacterManager(parent);
    manager.sync([{ id: "e1", state: "IDLE" }], placementsFor(["e1"]));
    const char = manager.get("e1");
    expect(char).toBeDefined();
    const startX = char?.group.position.x ?? NaN;

    manager.sync(
      [{ id: "e1", state: "IDLE" }],
      new Map([
        ["e1", { agentId: "e1", locationId: null, x: startX + 10, z: 5, yaw: 1, fallback: true }],
      ]),
    );
    manager.update(0.05, 1.0);
    const movedX = char?.group.position.x ?? startX;
    expect(movedX).toBeGreaterThan(startX);
    expect(movedX).toBeLessThan(startX + 10);
    expect(char?.group.position.y).toBe(0);
    // Unknown ids are safe no-ops.
    manager.setHighlight("ghost", "selected");
  });
});
