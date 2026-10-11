/**
 * Registry of the Blender-authored city models (tools/blender/buildings.py and
 * decor.py). Pure three.js: no loader and no DOM, so the Node test suite can feed
 * it stand-in scenes.
 *
 * Each GLB node becomes a prepared geometry with exactly the attributes the
 * procedural builders produce (`position`, flat `normal`, RGB `color`), so modelled
 * and procedural parts can be merged together and drawn with the same material.
 */
import * as THREE from "three";

const buildingModels = new Map<string, THREE.BufferGeometry>();
const decorModels = new Map<string, THREE.BufferGeometry[]>();

/** COLOR_0 (RGBA or RGB) → flat-shaded, non-indexed geometry with RGB `color`. */
export function prepareModelGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.index !== null ? source.toNonIndexed() : source.clone();
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== "position" && name !== "color") geometry.deleteAttribute(name);
  }
  const position = geometry.getAttribute("position");
  const color = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  const rgb = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    rgb[i * 3] = color !== undefined ? color.getX(i) : 1;
    rgb[i * 3 + 1] = color !== undefined ? color.getY(i) : 1;
    rgb[i * 3 + 2] = color !== undefined ? color.getZ(i) : 1;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
  geometry.computeVertexNormals(); // non-indexed → one normal per face (flat)
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) meshes.push(node);
  });
  return meshes;
}

/**
 * Installs the models from the loaded GLB scenes (`bld_<ARCHETYPE>` and
 * `dec_<KIND>[_n]` nodes). Passing null clears the registry.
 */
export function setWorldModels(buildings: THREE.Object3D | null, decor: THREE.Object3D | null): void {
  for (const geometry of buildingModels.values()) geometry.dispose();
  for (const list of decorModels.values()) for (const geometry of list) geometry.dispose();
  buildingModels.clear();
  decorModels.clear();
  if (buildings !== null) {
    for (const mesh of meshesOf(buildings)) {
      if (mesh.name.startsWith("bld_")) buildingModels.set(mesh.name.slice(4), prepareModelGeometry(mesh.geometry));
    }
  }
  if (decor !== null) {
    for (const mesh of meshesOf(decor)) {
      const match = /^dec_([A-Z]+)(?:_\d+)?$/.exec(mesh.name);
      if (match === null) continue;
      const kind = match[1] as string;
      const list = decorModels.get(kind) ?? [];
      list.push(prepareModelGeometry(mesh.geometry));
      decorModels.set(kind, list);
    }
  }
}

export function hasWorldModels(): boolean {
  return buildingModels.size > 0 || decorModels.size > 0;
}

/** Shared geometry for an archetype. Never dispose it per building. */
export function buildingModel(archetype: string): THREE.BufferGeometry | undefined {
  return buildingModels.get(archetype);
}

/** Variant geometries for a decor kind (empty when not modelled). */
export function decorModel(kind: string): readonly THREE.BufferGeometry[] {
  return decorModels.get(kind) ?? [];
}
