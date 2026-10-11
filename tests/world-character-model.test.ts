/**
 * Modelled characters (tools/blender/characters.py → public/models/character.glb).
 *
 * The factory must accept the Blender template through the same CharacterParts
 * contract the movement system animates, fall back to the procedural figure
 * when the template is unusable, and the committed GLB must carry every node
 * and material role the web app looks up.
 */
import { afterEach, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { buildCharacter, setCharacterTemplate, hasCharacterTemplate } from "../apps/web/src/world/characterFactory.js";
import { appearanceForAgentId } from "../apps/web/src/world/characterAppearance.js";
import { torsoRestY } from "../apps/web/src/world/agentMovement.js";

const PIVOTS = ["torso", "head", "armL", "armR", "legL", "legR"] as const;

function mesh(name: string, role: string): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial());
  (m.material as THREE.Material).name = role;
  m.name = name;
  return m;
}

/** Minimal stand-in with the same names and hierarchy as the exported model. */
function syntheticTemplate(options: { omit?: string } = {}): THREE.Object3D {
  const root = new THREE.Group();
  const node = (name: string, parent: THREE.Object3D, y: number, x = 0): THREE.Object3D => {
    const o = new THREE.Object3D();
    o.name = options.omit === name ? `${name}-renamed` : name;
    o.position.set(x, y, 0);
    parent.add(o);
    return o;
  };
  const legL = node("legL", root, 0.5, -0.11);
  const legR = node("legR", root, 0.5, 0.11);
  const torso = node("torso", root, 0.5);
  const armL = node("armL", torso, 0.42, -0.255);
  const armR = node("armR", torso, 0.42, 0.255);
  const head = node("head", torso, 0.5);
  legL.add(mesh("legL_mesh", "bottom"));
  legR.add(mesh("legR_mesh", "bottom"));
  torso.add(mesh("chest", "top"), mesh("chest__outline", "outline"));
  armL.add(mesh("armL_mesh", "top"));
  armR.add(mesh("armR_mesh", "top"));
  head.add(mesh("head_mesh", "skin"));
  for (let i = 0; i < 4; i += 1) head.add(mesh(`hair_${i}`, "hair"), mesh(`hair_${i}__outline`, "outline"));
  return root;
}

afterEach(() => setCharacterTemplate(null));

describe("modelled character template", () => {
  it("maps the template's named pivots onto CharacterParts and recolours by role", () => {
    setCharacterTemplate(syntheticTemplate());
    const appearance = appearanceForAgentId("agent-model-1");
    const built = buildCharacter("agent-model-1", appearance, "WORKING");

    for (const name of PIVOTS) expect(built.parts[name].name, name).toBe(name);
    // Hip height comes from the model, not the procedural 0.75.
    expect(torsoRestY(built.parts.torso)).toBeCloseTo(0.5);

    const hair = [0, 1, 2, 3].map((i) => built.group.getObjectByName(`hair_${i}`));
    expect(hair.filter((h) => h?.visible)).toHaveLength(1);
    expect(hair[appearance.hairStyle]?.visible).toBe(true);
    expect(built.group.getObjectByName(`hair_${appearance.hairStyle}__outline`)?.visible).toBe(true);

    const top = built.group.getObjectByName("chest") as THREE.Mesh;
    expect(top.material).toBeInstanceOf(THREE.MeshToonMaterial);
    expect((top.material as THREE.MeshToonMaterial).color.getHex()).toBe(appearance.clothing);
    const outline = built.group.getObjectByName("chest__outline") as THREE.Mesh;
    expect((outline.material as THREE.Material).side).toBe(THREE.BackSide);

    // Overlays keep working on the modelled body.
    expect(built.parts.badge.parent).toBe(built.group);
    expect(built.parts.bubble.visible).toBe(false);
  });

  it("does not mutate the shared template when building many agents", () => {
    const template = syntheticTemplate();
    setCharacterTemplate(template);
    const a = buildCharacter("agent-a", appearanceForAgentId("agent-a"), "IDLE");
    const b = buildCharacter("agent-b", appearanceForAgentId("agent-b"), "IDLE");
    expect(a.parts.torso).not.toBe(b.parts.torso);
    expect(template.getObjectByName("armL")?.position.x).toBeCloseTo(-0.255);
    expect(((template.getObjectByName("chest") as THREE.Mesh).material as THREE.Material).name).toBe("top");
  });

  it("falls back to the procedural figure when the template lacks a pivot", () => {
    setCharacterTemplate(syntheticTemplate({ omit: "armR" }));
    expect(hasCharacterTemplate()).toBe(true);
    const built = buildCharacter("agent-fallback", appearanceForAgentId("agent-fallback"), "IDLE");
    expect(torsoRestY(built.parts.torso)).toBeCloseTo(0.75);
    expect(built.group.getObjectByName("chest")).toBeUndefined();
  });
});

describe("committed character.glb", () => {
  it("carries every node and material role the web app looks up", () => {
    const glb = readFileSync(join(__dirname, "..", "apps", "web", "public", "models", "character.glb"));
    expect(glb.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
    const jsonLength = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as {
      nodes: Array<{ name?: string }>;
      materials: Array<{ name?: string }>;
    };
    const nodes = new Set(json.nodes.map((n) => n.name));
    for (const name of [...PIVOTS, "chest", "hair_0", "hair_1", "hair_2", "hair_3", "chest__outline"]) {
      expect(nodes.has(name), name).toBe(true);
    }
    const roles = new Set(json.materials.map((m) => m.name));
    for (const role of ["skin", "hair", "top", "bottom", "shoes", "eye", "white", "blush", "accent", "outline"]) {
      expect(roles.has(role), role).toBe(true);
    }
    expect(glb.length).toBeLessThan(400 * 1024);
  });
});
