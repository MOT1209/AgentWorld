/**
 * Procedural three.js construction for the world layout plan. Pure three —
 * no DOM, no renderer — so the Node test suite can build meshes headless.
 *
 * Every real building becomes ONE merged BufferGeometry (body + roof + door)
 * with a per-vertex color attribute and a single MeshStandardMaterial, so
 * selection emissive is per-building and draw calls stay low. Context
 * buildings use the same path with muted palettes.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type {
  BuildingArchetype,
  BuildingPlan,
  DecorPlan,
  GroundPatch,
  RoadSegment,
  WorldLayoutPlan,
} from "./types.js";

/* ------------------------------------------------------------------ colors */

const ARCHETYPE_COLORS: Record<BuildingArchetype, readonly [number, number, number]> = {
  HOUSE: [0.85, 0.76, 0.62],
  TOWNHOUSE: [0.78, 0.66, 0.55],
  APARTMENT: [0.72, 0.7, 0.68],
  SHOP: [0.82, 0.62, 0.4],
  RESTAURANT: [0.76, 0.5, 0.38],
  MARKET: [0.8, 0.68, 0.45],
  OFFICE: [0.6, 0.68, 0.76],
  HQ: [0.55, 0.62, 0.74],
  BANK: [0.68, 0.66, 0.6],
  CIVIC: [0.72, 0.7, 0.78],
  SCHOOL: [0.74, 0.68, 0.58],
  HOSPITAL: [0.86, 0.86, 0.84],
  PARK_PAVILION: [0.62, 0.72, 0.55],
  STATION: [0.66, 0.62, 0.58],
  WAREHOUSE: [0.64, 0.64, 0.62],
  GARAGE: [0.58, 0.58, 0.56],
  BARN: [0.7, 0.5, 0.36],
  CONTEXT_HOUSE: [0.6, 0.58, 0.54],
  CONTEXT_BLOCK: [0.52, 0.54, 0.58],
  CONTEXT_BARN: [0.56, 0.46, 0.38],
};

const ROOF_COLORS: Partial<Record<BuildingArchetype, readonly [number, number, number]>> = {
  HOUSE: [0.55, 0.32, 0.24],
  TOWNHOUSE: [0.5, 0.3, 0.26],
  BARN: [0.45, 0.3, 0.22],
  CONTEXT_HOUSE: [0.48, 0.32, 0.26],
  CONTEXT_BARN: [0.42, 0.3, 0.22],
  PARK_PAVILION: [0.42, 0.5, 0.38],
};

const CONTEXT_SATURATION = 0.55;

const SURFACE_COLORS: Record<string, readonly [number, number, number]> = {
  ASPHALT: [0.22, 0.23, 0.25],
  GRAVEL: [0.45, 0.42, 0.38],
  PAVING: [0.55, 0.52, 0.48],
  PATH: [0.62, 0.56, 0.46],
  PLAZA: [0.5, 0.48, 0.46],
  lawn: [0.32, 0.48, 0.28],
  FIELD: [0.42, 0.5, 0.3],
  POND: [0.25, 0.42, 0.55],
  LOT: [0.48, 0.44, 0.4],
};

const DECOR_COLORS: Record<DecorPlan["kind"], readonly [number, number, number]> = {
  TREE: [0.24, 0.45, 0.22],
  BUSH: [0.3, 0.5, 0.26],
  BENCH: [0.45, 0.34, 0.24],
  LAMP: [0.35, 0.36, 0.4],
  SIGN: [0.5, 0.48, 0.42],
  FOUNTAIN: [0.4, 0.55, 0.65],
};

function rgb(color: readonly [number, number, number]): THREE.Color {
  return new THREE.Color(color[0], color[1], color[2]);
}

function vary(color: THREE.Color, seed: number): THREE.Color {
  const factor = 0.92 + (seed % 7) * 0.025;
  return new THREE.Color(color.r * factor, color.g * factor, color.b * factor);
}

/* ------------------------------------------------------------ part helpers */

interface Part {
  geometry: THREE.BufferGeometry;
  color: THREE.Color;
}

function colorize(geometry: THREE.BufferGeometry, color: THREE.Color): Part {
  const nonIndexed = geometry.index !== null ? geometry.toNonIndexed() : geometry;
  nonIndexed.deleteAttribute("uv");
  nonIndexed.deleteAttribute("normal");
  nonIndexed.computeVertexNormals();
  const count = nonIndexed.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  nonIndexed.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (nonIndexed !== geometry) geometry.dispose();
  return { geometry: nonIndexed, color };
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.Color): Part {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return colorize(geometry, color);
}

/** Gabled roof: triangular prism along the building's local X axis. */
function gableRoof(w: number, depth: number, rise: number, y: number, color: THREE.Color): Part {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 - 0.4, 0);
  shape.lineTo(w / 2 + 0.4, 0);
  shape.lineTo(0, rise);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: depth + 0.8, bevelEnabled: false });
  geometry.translate(0, y, -(depth + 0.8) / 2);
  return colorize(geometry, color);
}

/** Hipped roof: 4-sided cone, rotated 45° so faces align with the footprint. */
function hipRoof(w: number, d: number, rise: number, y: number, color: THREE.Color): Part {
  const radius = (Math.SQRT1_2 * Math.max(w, d)) / 2 + 0.35;
  const geometry = new THREE.ConeGeometry(radius, rise, 4, 1);
  geometry.rotateY(Math.PI / 4);
  geometry.scale(w / Math.max(w, d), 1, d / Math.max(w, d));
  geometry.translate(0, y + rise / 2, 0);
  return colorize(geometry, color);
}

function flatRoof(w: number, d: number, y: number, color: THREE.Color): Part {
  return box(w + 0.5, 0.35, d + 0.5, 0, y + 0.17, 0, color);
}

function chimney(x: number, z: number, y: number, color: THREE.Color): Part {
  return box(0.7, 1.4, 0.7, x, y + 0.7, z, color);
}

/* -------------------------------------------------------- building meshes */

function mergeParts(parts: Part[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  const merged = mergeGeometries(
    parts.map((part) => part.geometry),
    false,
  );
  for (const part of parts) part.geometry.dispose();
  return merged;
}

/** One merged mesh per building: body + roof + door, vertex-colored. */
export function buildBuildingMesh(plan: BuildingPlan): THREE.Mesh {
  const { w, d, h } = plan.footprint;
  const base = vary(rgb(ARCHETYPE_COLORS[plan.archetype]), plan.tone);
  const roofPalette = ROOF_COLORS[plan.archetype] ?? [0.4, 0.42, 0.45];
  const roofColor = vary(rgb(roofPalette), plan.tone + 3);
  const parts: Part[] = [];

  // Context filler reads muted so real buildings stand out.
  if (plan.context) {
    base.multiplyScalar(CONTEXT_SATURATION + 0.25);
    roofColor.multiplyScalar(CONTEXT_SATURATION + 0.25);
  }

  const pitched = plan.archetype === "HOUSE" || plan.archetype === "TOWNHOUSE" || plan.archetype === "BARN" ||
    plan.archetype === "CONTEXT_HOUSE" || plan.archetype === "CONTEXT_BARN" || plan.archetype === "PARK_PAVILION";
  const hipped = plan.archetype === "APARTMENT" || plan.archetype === "OFFICE" || plan.archetype === "HQ" ||
    plan.archetype === "BANK" || plan.archetype === "HOSPITAL";

  parts.push(box(w, h, d, 0, h / 2, 0, base));
  if (pitched) {
    const rise = Math.min(2.8, h * 0.45);
    parts.push(gableRoof(w, d, rise, h, roofColor));
    if (plan.archetype === "HOUSE" || plan.archetype === "BARN") {
      parts.push(chimney(w * 0.3, -d * 0.15, h + rise * 0.35, vary(roofColor, plan.tone + 5)));
    }
  } else if (hipped) {
    parts.push(hipRoof(w, d, Math.min(3.2, h * 0.3), h, roofColor));
  } else {
    parts.push(flatRoof(w, d, h, roofColor));
  }

  // Door on the +Z face (archetype front). Skip on huge context blocks.
  if (!plan.context || plan.archetype !== "CONTEXT_BLOCK") {
    const doorColor = new THREE.Color(0.28, 0.2, 0.14);
    parts.push(box(1.2, 2.2, 0.22, 0, 1.1, d / 2 + 0.05, doorColor));
  }

  const geometry = mergeParts(parts);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false });
  const mesh = new THREE.Mesh(geometry ?? new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(plan.x, 0, plan.z);
  mesh.rotation.y = plan.rotation;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = {
    kind: "building",
    key: plan.key,
    locationId: plan.locationId,
    selectable: plan.selectable,
    context: plan.context,
  };
  return mesh;
}

/* --------------------------------------------------------- static meshes */

/** All road segments merged into one vertex-colored mesh. */
export function buildRoadMesh(segments: readonly RoadSegment[]): THREE.Mesh | null {
  const parts: Part[] = [];
  for (const seg of segments) {
    const length = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1);
    if (length < 0.01) continue;
    const angle = Math.atan2(seg.x2 - seg.x1, seg.z2 - seg.z1);
    const geometry = new THREE.PlaneGeometry(seg.width, length + seg.width * 0.5);
    geometry.rotateX(-Math.PI / 2);
    geometry.rotateY(angle);
    geometry.translate((seg.x1 + seg.x2) / 2, 0.02, (seg.z1 + seg.z2) / 2);
    parts.push(colorize(geometry, rgb(SURFACE_COLORS[seg.surface] ?? SURFACE_COLORS.ASPHALT ?? [0.3, 0.3, 0.3])));
    if (seg.sidewalk && seg.surface === "ASPHALT") {
      for (const side of [1, -1]) {
        const walk = new THREE.PlaneGeometry(1.4, length + seg.width * 0.5);
        walk.rotateX(-Math.PI / 2);
        walk.rotateY(angle);
        const nx = Math.cos(angle) * side * (seg.width / 2 + 0.7);
        const nz = -Math.sin(angle) * side * (seg.width / 2 + 0.7);
        walk.translate((seg.x1 + seg.x2) / 2 + nx, 0.025, (seg.z1 + seg.z2) / 2 + nz);
        parts.push(colorize(walk, rgb(SURFACE_COLORS.PAVING ?? [0.5, 0.5, 0.5])));
      }
    }
  }
  const geometry = mergeParts(parts);
  if (geometry === null) return null;
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true }));
  mesh.receiveShadow = true;
  mesh.userData = { kind: "roads" };
  return mesh;
}

/** All ground patches (plaza/lawn/pond/field/lot/path) merged into one mesh. */
export function buildPatchMesh(patches: readonly GroundPatch[]): THREE.Mesh | null {
  const parts: Part[] = [];
  for (const patch of patches) {
    const geometry = new THREE.PlaneGeometry(patch.w, patch.h);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(patch.x, 0.01, patch.z);
    const key = patch.kind === "LAWN" ? "lawn" : patch.kind;
    parts.push(colorize(geometry, rgb(SURFACE_COLORS[key] ?? SURFACE_COLORS.LOT ?? [0.5, 0.5, 0.5])));
  }
  const geometry = mergeParts(parts);
  if (geometry === null) return null;
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true }));
  mesh.receiveShadow = true;
  mesh.userData = { kind: "patches" };
  return mesh;
}

/** Decor items grouped into a few merged meshes by kind family. */
export function buildDecorMeshes(items: readonly DecorPlan[]): THREE.Mesh[] {
  const trees: Part[] = [];
  const props: Part[] = [];
  for (const item of items) {
    const color = vary(rgb(DECOR_COLORS[item.kind]), item.tone);
    if (item.kind === "TREE") {
      const trunk = new THREE.CylinderGeometry(0.22 * item.scale, 0.3 * item.scale, 1.8 * item.scale, 5);
      trunk.translate(item.x, 0.9 * item.scale, item.z);
      trees.push(colorize(trunk, new THREE.Color(0.35, 0.26, 0.18)));
      const crown = new THREE.ConeGeometry(1.5 * item.scale, 3.4 * item.scale, 6);
      crown.translate(item.x, 3.4 * item.scale, item.z);
      trees.push(colorize(crown, color));
    } else if (item.kind === "BUSH") {
      const crown = new THREE.SphereGeometry(0.9 * item.scale, 6, 5);
      crown.translate(item.x, 0.7 * item.scale, item.z);
      trees.push(colorize(crown, color));
    } else if (item.kind === "BENCH") {
      props.push(box(2 * item.scale, 0.12, 0.55, item.x, 0.55, item.z, color));
      props.push(box(2 * item.scale, 0.5, 0.1, item.x, 0.85, item.z - 0.22, color));
    } else if (item.kind === "LAMP") {
      const pole = new THREE.CylinderGeometry(0.08, 0.1, 3.4, 5);
      pole.translate(item.x, 1.7, item.z);
      props.push(colorize(pole, color));
      const head = new THREE.SphereGeometry(0.28, 6, 5);
      head.translate(item.x, 3.5, item.z);
      props.push(colorize(head, new THREE.Color(0.95, 0.9, 0.7)));
    } else if (item.kind === "SIGN") {
      props.push(box(0.12, 1.5, 0.12, item.x, 0.75, item.z, new THREE.Color(0.4, 0.38, 0.34)));
      props.push(box(0.9, 0.55, 0.08, item.x, 1.55, item.z, color));
    } else if (item.kind === "FOUNTAIN") {
      const basin = new THREE.CylinderGeometry(2.6, 2.9, 0.7, 12);
      basin.translate(item.x, 0.35, item.z);
      props.push(colorize(basin, color));
      const column = new THREE.CylinderGeometry(0.3, 0.45, 1.6, 8);
      column.translate(item.x, 1.3, item.z);
      props.push(colorize(column, new THREE.Color(0.75, 0.75, 0.72)));
    }
  }
  const meshes: THREE.Mesh[] = [];
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  for (const parts of [trees, props]) {
    const geometry = mergeParts(parts);
    if (geometry === null) continue;
    const mesh = new THREE.Mesh(geometry, material.clone());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { kind: "decor" };
    meshes.push(mesh);
  }
  material.dispose();
  return meshes;
}

/** Flat ground disc sized to the plan. */
export function buildGround(size: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x2a3326, roughness: 1 }),
  );
  mesh.position.y = -0.03;
  mesh.receiveShadow = true;
  mesh.userData = { kind: "ground" };
  return mesh;
}

/** Buildings belonging to a plan keyed for reconcile (real + context). */
export function buildingsByKey(plan: WorldLayoutPlan): Map<string, BuildingPlan> {
  const map = new Map<string, BuildingPlan>();
  for (const building of plan.buildings) map.set(building.key, building);
  return map;
}
