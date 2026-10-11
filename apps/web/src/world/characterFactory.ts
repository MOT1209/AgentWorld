/**
 * 3D human character factory.
 *
 * Every character shares cached geometries and a small palette of cached
 * materials, so N agents cost ~N groups/draw-call overhead instead of N
 * unique GPU resources. Per-character variation comes from choosing among the
 * shared materials/geometries deterministically (see characterAppearance.ts).
 *
 * Two bodies share one contract (CharacterParts + overlays):
 *   - the modelled chibi from tools/blender/characters.py, used once its GLB
 *     has loaded: hips 0.5 · neck 1.0 · head centre 1.3 (r 0.3) · cel-shaded
 *     with baked outlines, recoloured per agent by material role;
 *   - the procedural primitive figure (fallback): legs 0–0.75 · torso
 *     0.75–1.30 · head centre 1.56 (r 0.16).
 * Both keep the state badge at 1.98.
 * The group is uniformly scaled by CHARACTER_SCALE for readability at the
 * normal desktop camera distance.
 */

import * as THREE from "three";
import {
  stateColorHex,
  type CharacterAppearance,
} from "./characterAppearance.js";

export const CHARACTER_SCALE = 1.35;
/** World-space height above the character origin used to anchor labels. */
export const LABEL_ANCHOR_HEIGHT = 2.95;

export type HighlightMode = "none" | "hover" | "selected";

export interface CharacterParts {
  torso: THREE.Object3D;
  head: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  /** Hip pivots for the walk cycle (Step 3); idle leaves them neutral. */
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  badge: THREE.Mesh;
  ring: THREE.Mesh;
  /** Social bubble (Step 4): shown when chatting with a nearby agent. */
  bubble: THREE.Mesh;
}

export interface BuiltCharacter {
  group: THREE.Group;
  parts: CharacterParts;
  appearance: CharacterAppearance;
  setStateColor: (state: string) => void;
  setHighlight: (mode: HighlightMode) => void;
}

/* ------------------------------------------------------- shared caches */

const geometryCache = new Map<string, THREE.BufferGeometry>();
const materialCache = new Map<string, THREE.Material>();

function cachedGeometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const existing = geometryCache.get(key);
  if (existing !== undefined) return existing;
  const created = create();
  geometryCache.set(key, created);
  return created;
}

function standardMaterial(color: number, roughness: number): THREE.MeshStandardMaterial {
  const key = `std:${color.toString(16)}:${roughness}`;
  const existing = materialCache.get(key);
  if (existing !== undefined) return existing as THREE.MeshStandardMaterial;
  const created = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
  materialCache.set(key, created);
  return created;
}

function stateMaterial(colorHex: number): THREE.MeshStandardMaterial {
  const key = `state:${colorHex.toString(16)}`;
  const existing = materialCache.get(key);
  if (existing !== undefined) return existing as THREE.MeshStandardMaterial;
  const created = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.35,
    metalness: 0.1,
    emissive: colorHex,
    emissiveIntensity: 0.35,
  });
  materialCache.set(key, created);
  return created;
}

function highlightMaterial(mode: Exclude<HighlightMode, "none">): THREE.MeshBasicMaterial {
  const key = `ring:${mode}`;
  const existing = materialCache.get(key);
  if (existing !== undefined) return existing as THREE.MeshBasicMaterial;
  const created = new THREE.MeshBasicMaterial({
    color: mode === "selected" ? 0xfbbf24 : 0x93c5fd,
    transparent: true,
    opacity: mode === "selected" ? 0.95 : 0.7,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  materialCache.set(key, created);
  return created;
}

function hitMaterial(): THREE.MeshBasicMaterial {
  const key = "hit:invisible";
  const existing = materialCache.get(key);
  if (existing !== undefined) return existing as THREE.MeshBasicMaterial;
  const created = new THREE.MeshBasicMaterial({ visible: false });
  materialCache.set(key, created);
  return created;
}

function bubbleMaterial(): THREE.MeshBasicMaterial {
  const key = "bubble:chat";
  const existing = materialCache.get(key);
  if (existing !== undefined) return existing as THREE.MeshBasicMaterial;
  const created = new THREE.MeshBasicMaterial({ color: 0xf8fafc });
  materialCache.set(key, created);
  return created;
}

function geometries(): Record<string, THREE.BufferGeometry> {
  return {
    leg: cachedGeometry("leg", () => new THREE.CylinderGeometry(0.085, 0.095, 0.75, 10)),
    shoe: cachedGeometry("shoe", () => new THREE.BoxGeometry(0.15, 0.12, 0.27)),
    torso: cachedGeometry("torso", () => new THREE.CylinderGeometry(0.2, 0.155, 0.55, 14)),
    shoulder: cachedGeometry("shoulder", () => new THREE.BoxGeometry(0.5, 0.13, 0.2)),
    arm: cachedGeometry("arm", () => new THREE.CylinderGeometry(0.055, 0.05, 0.52, 8)),
    hand: cachedGeometry("hand", () => new THREE.SphereGeometry(0.06, 8, 8)),
    neck: cachedGeometry("neck", () => new THREE.CylinderGeometry(0.06, 0.06, 0.12, 8)),
    head: cachedGeometry("head", () => new THREE.SphereGeometry(0.16, 18, 14)),
    hairCap: cachedGeometry("hairCap", () => new THREE.SphereGeometry(0.17, 14, 10)),
    hairBun: cachedGeometry("hairBun", () => new THREE.SphereGeometry(0.07, 10, 8)),
    hairFlat: cachedGeometry("hairFlat", () => new THREE.BoxGeometry(0.26, 0.09, 0.26)),
    hairFringe: cachedGeometry("hairFringe", () => new THREE.BoxGeometry(0.2, 0.06, 0.08)),
    eye: cachedGeometry("eye", () => new THREE.SphereGeometry(0.022, 6, 6)),
    badge: cachedGeometry("badge", () => new THREE.OctahedronGeometry(0.09)),
    ring: cachedGeometry("ring", () => new THREE.RingGeometry(0.42, 0.55, 28)),
    bubble: cachedGeometry("bubble", () => new THREE.SphereGeometry(0.09, 10, 8)),
    hit: cachedGeometry("hit", () => new THREE.CylinderGeometry(0.55, 0.55, 2.1, 8)),
  };
}

const BUILD_WIDTH = [0.88, 1.0, 1.14] as const;

/* ------------------------------------------------- modelled template */

/**
 * The Blender-authored character (tools/blender/characters.py), set once the
 * GLB has loaded (characterAssets.ts). While it is null, or if it lacks a
 * required node, the procedural builder below is used, so the world never
 * depends on the asset being present.
 */
let characterTemplate: THREE.Object3D | null = null;

export function setCharacterTemplate(template: THREE.Object3D | null): void {
  characterTemplate = template;
}

export function hasCharacterTemplate(): boolean {
  return characterTemplate !== null;
}

const PIVOT_NAMES = ["torso", "head", "armL", "armR", "legL", "legR"] as const;
const HAIR_VARIANTS = 4;

/** Colours for material roles the agent palette does not drive. */
const FIXED_ROLE_COLORS: Readonly<Record<string, number>> = {
  shoes: 0x2b2233,
  eye: 0x1c1917,
  white: 0xffffff,
  blush: 0xf59e9e,
  accent: 0xf8fafc,
};
const OUTLINE_COLOR = 0x2b2233;

let toonGradient: THREE.DataTexture | null = null;

/** Three-band ramp for the cel-shaded look (shadow, mid, lit). */
function toonGradientMap(): THREE.DataTexture {
  if (toonGradient !== null) return toonGradient;
  const tones = new Uint8Array([110, 110, 110, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
  toonGradient = new THREE.DataTexture(tones, 3, 1, THREE.RGBAFormat);
  toonGradient.minFilter = THREE.NearestFilter;
  toonGradient.magFilter = THREE.NearestFilter;
  toonGradient.generateMipmaps = false;
  toonGradient.needsUpdate = true;
  return toonGradient;
}

function toonMaterial(color: number): THREE.MeshToonMaterial {
  const key = `toon:${color.toString(16)}`;
  const existing = materialCache.get(key);
  if (existing !== undefined) return existing as THREE.MeshToonMaterial;
  const created = new THREE.MeshToonMaterial({ color, gradientMap: toonGradientMap() });
  materialCache.set(key, created);
  return created;
}

/** Inverted-hull outline: unlit, back faces only (the hull is baked in Blender). */
function outlineMaterial(): THREE.MeshBasicMaterial {
  const key = "outline:hull";
  const existing = materialCache.get(key);
  if (existing !== undefined) return existing as THREE.MeshBasicMaterial;
  const created = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
  materialCache.set(key, created);
  return created;
}

function materialName(material: THREE.Material | THREE.Material[]): string {
  return Array.isArray(material) ? (material[0]?.name ?? "") : material.name;
}

/**
 * Builds the figure body from the modelled template, or returns null when the
 * template is missing a pivot (the caller then falls back to procedural).
 */
function bodyFromTemplate(
  template: THREE.Object3D,
  appearance: CharacterAppearance,
): { body: THREE.Object3D; pivots: Record<(typeof PIVOT_NAMES)[number], THREE.Object3D> } | null {
  const body = template.clone(true);
  const pivots = {} as Record<(typeof PIVOT_NAMES)[number], THREE.Object3D>;
  for (const name of PIVOT_NAMES) {
    const node = body.getObjectByName(name);
    if (node === undefined) return null;
    pivots[name] = node;
  }
  const roleColors: Readonly<Record<string, number>> = {
    ...FIXED_ROLE_COLORS,
    skin: appearance.skin,
    hair: appearance.hair,
    top: appearance.clothing,
    bottom: appearance.pants,
  };
  body.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const role = materialName(node.material);
    node.material = role === "outline" ? outlineMaterial() : toonMaterial(roleColors[role] ?? 0xcbd5e1);
  });
  const style = appearance.hairStyle % HAIR_VARIANTS;
  for (let i = 0; i < HAIR_VARIANTS; i += 1) {
    for (const suffix of ["", "__outline"]) {
      const hair = body.getObjectByName(`hair_${i}${suffix}`);
      if (hair !== undefined) hair.visible = i === style;
    }
  }
  const width = BUILD_WIDTH[appearance.build % BUILD_WIDTH.length] ?? 1.0;
  for (const name of ["chest", "chest__outline"]) {
    const chest = body.getObjectByName(name);
    if (chest !== undefined) chest.scale.x = width;
  }
  pivots.armL.position.x *= width;
  pivots.armR.position.x *= width;
  pivots.torso.userData = { ...pivots.torso.userData, restY: pivots.torso.position.y };
  return { body, pivots };
}

/* ------------------------------------------------------------- factory */

function buildHair(
  geo: Record<string, THREE.BufferGeometry>,
  hairStyle: number,
  hairMat: THREE.Material,
  head: THREE.Group,
): void {
  const cap = new THREE.Mesh(geo["hairCap"] as THREE.BufferGeometry, hairMat);
  if (hairStyle === 2) {
    const flat = new THREE.Mesh(geo["hairFlat"] as THREE.BufferGeometry, hairMat);
    flat.position.set(0, 0.29, 0);
    head.add(flat);
    return;
  }
  cap.scale.set(1, 0.75, 1);
  if (hairStyle === 3) {
    cap.position.set(0.03, 0.19, -0.01);
    const fringe = new THREE.Mesh(geo["hairFringe"] as THREE.BufferGeometry, hairMat);
    fringe.position.set(0.02, 0.27, 0.1);
    head.add(fringe);
  } else {
    cap.position.set(0, 0.19, -0.01);
  }
  head.add(cap);
  if (hairStyle === 1) {
    const bun = new THREE.Mesh(geo["hairBun"] as THREE.BufferGeometry, hairMat);
    bun.position.set(0, 0.29, -0.13);
    head.add(bun);
  }
}

/** The original primitive figure: used until (or unless) the modelled template is available. */
function proceduralBody(
  group: THREE.Group,
  appearance: CharacterAppearance,
): Record<(typeof PIVOT_NAMES)[number], THREE.Object3D> {
  const geo = geometries();
  const skinMat = standardMaterial(appearance.skin, 0.6);
  const clothMat = standardMaterial(appearance.clothing, 0.8);
  const pantsMat = standardMaterial(appearance.pants, 0.85);
  const hairMat = standardMaterial(appearance.hair, 0.9);
  const shoeMat = standardMaterial(0x1f2937, 0.9);
  const eyeMat = standardMaterial(0x1c1917, 0.5);

  const width = BUILD_WIDTH[appearance.build % BUILD_WIDTH.length] ?? 1.0;

  // -- legs + footwear (hip pivots; neutral at rest, driven by walk cycle) --
  const legL = new THREE.Group();
  legL.position.set(-0.11, 0.75, 0);
  const legR = new THREE.Group();
  legR.position.set(0.11, 0.75, 0);
  for (const pivot of [legL, legR] as const) {
    const leg = new THREE.Mesh(geo["leg"] as THREE.BufferGeometry, pantsMat);
    leg.position.set(0, -0.375, 0);
    pivot.add(leg);
    const shoe = new THREE.Mesh(geo["shoe"] as THREE.BufferGeometry, shoeMat);
    shoe.position.set(0, -0.69, 0.04);
    pivot.add(shoe);
    group.add(pivot);
  }

  // -- upper body (animated pivot at the hips) ----------------------------
  const torso = new THREE.Group();
  torso.position.set(0, 0.75, 0);
  group.add(torso);

  const chest = new THREE.Mesh(geo["torso"] as THREE.BufferGeometry, clothMat);
  chest.scale.x = width;
  chest.position.set(0, 0.275, 0);
  torso.add(chest);

  const shoulders = new THREE.Mesh(geo["shoulder"] as THREE.BufferGeometry, clothMat);
  shoulders.scale.x = width;
  shoulders.position.set(0, 0.52, 0);
  torso.add(shoulders);

  // -- arms (pivots at the shoulders for idle sway) ------------------------
  const armL = new THREE.Group();
  armL.position.set(-0.27 * width, 0.51, 0);
  armL.rotation.z = 0.07;
  const armLMesh = new THREE.Mesh(geo["arm"] as THREE.BufferGeometry, clothMat);
  armLMesh.position.set(0, -0.26, 0);
  armL.add(armLMesh);
  const handL = new THREE.Mesh(geo["hand"] as THREE.BufferGeometry, skinMat);
  handL.position.set(0, -0.55, 0);
  armL.add(handL);
  torso.add(armL);

  const armR = new THREE.Group();
  armR.position.set(0.27 * width, 0.51, 0);
  armR.rotation.z = -0.07;
  const armRMesh = new THREE.Mesh(geo["arm"] as THREE.BufferGeometry, clothMat);
  armRMesh.position.set(0, -0.26, 0);
  armR.add(armRMesh);
  const handR = new THREE.Mesh(geo["hand"] as THREE.BufferGeometry, skinMat);
  handR.position.set(0, -0.55, 0);
  armR.add(handR);
  torso.add(armR);

  // -- neck + head ----------------------------------------------------------
  const neck = new THREE.Mesh(geo["neck"] as THREE.BufferGeometry, skinMat);
  neck.position.set(0, 0.6, 0);
  torso.add(neck);

  const head = new THREE.Group();
  head.position.set(0, 0.68, 0);
  const skull = new THREE.Mesh(geo["head"] as THREE.BufferGeometry, skinMat);
  skull.position.set(0, 0.13, 0);
  head.add(skull);
  buildHair(geo, appearance.hairStyle, hairMat, head);
  for (const side of [-1, 1] as const) {
    const eye = new THREE.Mesh(geo["eye"] as THREE.BufferGeometry, eyeMat);
    eye.position.set(side * 0.06, 0.14, 0.145);
    head.add(eye);
  }
  torso.add(head);

  return { torso, head, armL, armR, legL, legR };
}

/**
 * Builds a recognizable stylized human character. The returned group is
 * owned by the caller (add it to the scene, remove on deletion); geometries
 * and materials stay shared and must NOT be disposed per character — use
 * {@link disposeSharedCaches} once when the whole view unmounts.
 */
export function buildCharacter(
  agentId: string,
  appearance: CharacterAppearance,
  state: string,
): BuiltCharacter {
  const geo = geometries();
  const group = new THREE.Group();
  group.name = `agent:${agentId}`;
  group.userData = { kind: "character", agentId };
  group.scale.setScalar(CHARACTER_SCALE);

  const modelled = characterTemplate !== null ? bodyFromTemplate(characterTemplate, appearance) : null;
  let pivots: Record<(typeof PIVOT_NAMES)[number], THREE.Object3D>;
  if (modelled !== null) {
    group.add(modelled.body);
    pivots = modelled.pivots;
  } else {
    pivots = proceduralBody(group, appearance);
  }
  const { torso, head, armL, armR, legL, legR } = pivots;

  // -- state badge (shared per-state material, swapped on update) ----------
  const badge = new THREE.Mesh(
    geo["badge"] as THREE.BufferGeometry,
    stateMaterial(stateColorHex(state)),
  );
  badge.position.set(0, 1.98, 0);
  group.add(badge);

  // -- selection ring --------------------------------------------------------
  const ring = new THREE.Mesh(geo["ring"] as THREE.BufferGeometry, highlightMaterial("selected"));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 0.03, 0);
  ring.visible = false;
  group.add(ring);

  // -- invisible hit proxy for cheap, forgiving raycasts --------------------
  const hit = new THREE.Mesh(geo["hit"] as THREE.BufferGeometry, hitMaterial());
  hit.position.set(0, 1.05, 0);
  hit.userData = { kind: "character-hit", agentId };
  group.add(hit);

  // -- social bubble (hidden unless chatting nearby; Step 4) -----------------
  const bubble = new THREE.Mesh(geo["bubble"] as THREE.BufferGeometry, bubbleMaterial());
  // Beside the head: the modelled chibi head is larger than the procedural one.
  if (modelled !== null) bubble.position.set(0.46, 1.74, 0.05);
  else bubble.position.set(0.3, 1.62, 0.05);
  bubble.visible = false;
  group.add(bubble);

  const parts: CharacterParts = { torso, head, armL, armR, legL, legR, badge, ring, bubble };

  return {
    group,
    parts,
    appearance,
    setStateColor: (next: string): void => {
      badge.material = stateMaterial(stateColorHex(next));
    },
    setHighlight: (mode: HighlightMode): void => {
      if (mode === "none") {
        ring.visible = false;
        return;
      }
      ring.visible = true;
      ring.material = highlightMaterial(mode);
    },
  };
}

/** Walks up the parent chain to the character group (if any). */
export function findCharacterAgentId(target: THREE.Object3D | null): string | null {
  let current: THREE.Object3D | null = target;
  while (current !== null) {
    const data = current.userData as { kind?: unknown; agentId?: unknown };
    if (data.kind === "character" && typeof data.agentId === "string") return data.agentId;
    if (data.kind === "character-hit" && typeof data.agentId === "string") return data.agentId;
    current = current.parent;
  }
  return null;
}

/** Detaches a character group. Shared resources are left untouched. */
export function disposeCharacter(group: THREE.Group): void {
  group.parent?.remove(group);
}

/** Releases every shared geometry/material. Call once on view unmount. */
export function disposeSharedCaches(): void {
  for (const geometry of geometryCache.values()) geometry.dispose();
  geometryCache.clear();
  for (const material of materialCache.values()) material.dispose();
  materialCache.clear();
}

/** Test hook: how many shared geometries currently exist. */
export function sharedGeometryCount(): number {
  return geometryCache.size;
}
