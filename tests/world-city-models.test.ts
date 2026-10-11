/**
 * Modelled city (tools/blender/buildings.py + decor.py → public/models/*.glb).
 *
 * The registry must turn GLB nodes into geometry the procedural builders can merge
 * with; buildings must share one geometry per archetype (never disposed per
 * building) and keep selection/highlight working; decor must merge into the family
 * meshes; and the committed GLBs must carry every archetype and decor kind.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { WorldScene } from "../apps/web/src/world/scene.js";
import { computeLayout } from "../apps/web/src/world/layout.js";
import { buildBuildingMesh, buildDecorMeshes } from "../apps/web/src/world/buildings.js";
import { buildingModel, decorModel, prepareModelGeometry, setWorldModels } from "../apps/web/src/world/worldModels.js";
import type { BuildingArchetype, BuildingPlan, DistrictDto, LocationDto } from "../apps/web/src/world/types.js";

const ARCHETYPES: BuildingArchetype[] = [
  "HOUSE", "TOWNHOUSE", "APARTMENT", "SHOP", "RESTAURANT", "MARKET", "OFFICE", "HQ", "BANK", "CIVIC",
  "SCHOOL", "HOSPITAL", "PARK_PAVILION", "STATION", "WAREHOUSE", "GARAGE", "BARN", "CONTEXT_HOUSE",
  "CONTEXT_BLOCK", "CONTEXT_BARN",
];
const DECOR_NODES = ["dec_TREE_0", "dec_TREE_1", "dec_TREE_2", "dec_BUSH", "dec_BENCH", "dec_LAMP", "dec_SIGN", "dec_FOUNTAIN"];

/** Indexed box with an RGBA COLOR_0-style attribute, like GLTFLoader yields. */
function gltfLikeMesh(name: string, rgba: [number, number, number, number]): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(2, 3, 2);
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) colors.set(rgba, i * 4);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = name;
  return mesh;
}

function stubScenes(): { buildings: THREE.Group; decor: THREE.Group } {
  const buildings = new THREE.Group();
  for (const archetype of ARCHETYPES) buildings.add(gltfLikeMesh(`bld_${archetype}`, [0.8, 0.6, 0.4, 1]));
  const decor = new THREE.Group();
  for (const name of DECOR_NODES) decor.add(gltfLikeMesh(name, [0.2, 0.7, 0.3, 1]));
  return { buildings, decor };
}

function plan(partial: Partial<BuildingPlan> = {}): BuildingPlan {
  return {
    key: "loc-1", locationId: "loc-1", name: "HQ", kind: "HQ", archetype: "HQ",
    districtId: null, districtName: null, cityName: null, address: null,
    x: 10, z: -4, rotation: 0.5, footprint: { w: 20, d: 14, h: 24 }, tone: 3,
    occupants: { count: 0, capacity: null }, context: false, selectable: true,
    ...partial,
  };
}

afterEach(() => setWorldModels(null, null));

describe("world model registry", () => {
  it("prepares flat-shaded, non-indexed geometry with RGB colour only", () => {
    const geometry = prepareModelGeometry(gltfLikeMesh("x", [0.1, 0.2, 0.3, 1]).geometry);
    expect(geometry.index).toBeNull();
    expect(Object.keys(geometry.attributes).sort()).toEqual(["color", "normal", "position"]);
    expect(geometry.getAttribute("color").itemSize).toBe(3);
    expect(geometry.getAttribute("color").getY(0)).toBeCloseTo(0.2);
  });

  it("indexes buildings by archetype and decor by kind with variants", () => {
    const { buildings, decor } = stubScenes();
    setWorldModels(buildings, decor);
    for (const archetype of ARCHETYPES) expect(buildingModel(archetype), archetype).toBeDefined();
    expect(decorModel("TREE")).toHaveLength(3);
    expect(decorModel("FOUNTAIN")).toHaveLength(1);
    expect(decorModel("UNKNOWN")).toHaveLength(0);
  });
});

describe("modelled buildings", () => {
  it("share the archetype geometry with a per-building toon material and the same userData", () => {
    const { buildings, decor } = stubScenes();
    setWorldModels(buildings, decor);
    const a = buildBuildingMesh(plan());
    const b = buildBuildingMesh(plan({ key: "loc-2", locationId: "loc-2", tone: 0 }));
    expect(a.geometry).toBe(buildingModel("HQ"));
    expect(a.geometry).toBe(b.geometry);
    expect(a.material).not.toBe(b.material);
    expect(a.material).toBeInstanceOf(THREE.MeshToonMaterial);
    expect((a.material as THREE.MeshToonMaterial).vertexColors).toBe(true);
    expect(a.userData).toMatchObject({ kind: "building", key: "loc-1", locationId: "loc-1", selectable: true, sharedGeometry: true });
    expect([a.position.x, a.position.z, a.rotation.y]).toEqual([10, -4, 0.5]);

    const muted = buildBuildingMesh(plan({ context: true, selectable: false, locationId: null, key: "ctx:1" }));
    const tintOf = (m: THREE.Mesh) => (m.material as THREE.MeshToonMaterial).color.r;
    expect(tintOf(muted)).toBeLessThan(tintOf(a));
  });

  it("fall back to procedural geometry when no model is installed", () => {
    const mesh = buildBuildingMesh(plan());
    expect(mesh.userData.sharedGeometry).toBeUndefined();
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
  });

  it("merge modelled decor into the family meshes", () => {
    const { buildings, decor } = stubScenes();
    setWorldModels(buildings, decor);
    const template = decorModel("TREE")[1] as THREE.BufferGeometry;
    const before = Array.from(template.getAttribute("position").array);
    const colorBefore = Array.from(template.getAttribute("color").array);
    const meshes = buildDecorMeshes([
      { key: "t1", kind: "TREE", x: 0, z: 0, rotation: 0, scale: 1, tone: 1 },
      { key: "t2", kind: "TREE", x: 5, z: 0, rotation: 1, scale: 1.2, tone: 2 },
      { key: "l1", kind: "LAMP", x: 2, z: 2, rotation: 0, scale: 1, tone: 0 },
    ]);
    expect(meshes).toHaveLength(2);
    const perBox = buildingModel("HQ")?.getAttribute("position").count ?? 0;
    expect(meshes[0]?.geometry.getAttribute("position").count).toBe(perBox * 2);
    // The shared template stays untouched by per-item transforms and tints.
    expect(Array.from(template.getAttribute("position").array)).toEqual(before);
    expect(Array.from(template.getAttribute("color").array)).toEqual(colorBefore);
  });
});

describe("WorldScene with models", () => {
  const district = (id: string, kind: string): DistrictDto => ({
    id, cityId: "c-1", name: id, kind, cityName: "Testville", description: null, geometry: null, locationCount: 0,
  });
  const location = (id: string, kind: string, districtId: string): LocationDto => ({
    id, name: id, kind, cityId: "c-1", districtId, cityName: "Testville", capacity: null, occupantCount: 0,
  });
  const layout = () =>
    computeLayout({
      districts: [district("d-centre", "CITY_CENTRE"), district("d-resi", "RESIDENTIAL")],
      locations: [location("loc-hq", "HQ", "d-centre"), location("loc-house", "HOME", "d-resi")],
      includeContext: true,
    });

  it("rebuildModels swaps procedural meshes for modelled ones and keeps the selection", () => {
    const scene = new WorldScene();
    scene.applyPlan(layout());
    scene.setSelected("loc-hq");
    const before = scene.buildingMeshes().get("loc-hq");
    expect(before?.userData.sharedGeometry).toBeUndefined();

    const { buildings, decor } = stubScenes();
    setWorldModels(buildings, decor);
    scene.rebuildModels();
    const after = scene.buildingMeshes().get("loc-hq");
    expect(after).not.toBe(before);
    expect(after?.userData.sharedGeometry).toBe(true);
    expect((after?.material as THREE.MeshToonMaterial).emissive.getHex()).not.toBe(0);
    scene.dispose();
  });

  it("never disposes shared geometry when buildings are removed or the scene is disposed", () => {
    const { buildings, decor } = stubScenes();
    setWorldModels(buildings, decor);
    const shared = buildingModel("HQ") as THREE.BufferGeometry;
    const spy = vi.spyOn(shared, "dispose");
    const scene = new WorldScene();
    scene.applyPlan(layout());
    scene.applyPlan({ ...layout(), buildings: [] });
    scene.dispose();
    expect(spy).not.toHaveBeenCalled();
  });
});

function glbJson(file: string): { nodes: Array<{ name?: string; mesh?: number }>; meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }> } {
  const glb = readFileSync(join(__dirname, "..", "apps", "web", "public", "models", file));
  expect(glb.readUInt32LE(0)).toBe(0x46546c67);
  return JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
}

describe("committed city GLBs", () => {
  it("buildings.glb has one coloured mesh per archetype and no normals", () => {
    const json = glbJson("buildings.glb");
    const names = new Set(json.nodes.map((n) => n.name));
    for (const archetype of ARCHETYPES) expect(names.has(`bld_${archetype}`), archetype).toBe(true);
    for (const mesh of json.meshes) {
      for (const primitive of mesh.primitives) {
        expect(primitive.attributes.COLOR_0).toBeDefined();
        expect(primitive.attributes.NORMAL).toBeUndefined();
      }
    }
  });

  it("decor.glb has every decor kind", () => {
    const names = new Set(glbJson("decor.glb").nodes.map((n) => n.name));
    for (const name of DECOR_NODES) expect(names.has(name), name).toBe(true);
  });

  it("all models stay within the download budget", () => {
    const dir = join(__dirname, "..", "apps", "web", "public", "models");
    const total = ["buildings.glb", "decor.glb", "character.glb"].reduce((sum, f) => sum + readFileSync(join(dir, f)).length, 0);
    expect(total).toBeLessThan(1.5 * 1024 * 1024);
  });
});
