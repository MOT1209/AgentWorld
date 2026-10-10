/**
 * WorldScene headless tests: apply a layout plan, raycast-pick real
 * buildings, skip context filler, reconcile without leaking, highlight.
 *
 * Uses a real Raycaster against real meshes — no renderer, no DOM.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { WorldScene } from "../apps/web/src/world/scene.js";
import { computeLayout } from "../apps/web/src/world/layout.js";
import { buildBuildingMesh } from "../apps/web/src/world/buildings.js";
import type { DistrictDto, LocationDto } from "../apps/web/src/world/types.js";

function district(partial: Partial<DistrictDto> & Pick<DistrictDto, "id" | "cityId" | "name" | "kind">): DistrictDto {
  return {
    cityName: "Testville",
    description: null,
    geometry: null,
    locationCount: 0,
    ...partial,
  };
}

function location(
  partial: Partial<LocationDto> & Pick<LocationDto, "id" | "name" | "kind" | "cityId">,
): LocationDto {
  return {
    cityName: "Testville",
    districtId: null,
    capacity: null,
    occupantCount: 0,
    ...partial,
  };
}

const DISTRICTS: DistrictDto[] = [
  district({ id: "d-centre", cityId: "c-1", name: "Altstadt", kind: "CITY_CENTRE" }),
  district({ id: "d-resi", cityId: "c-1", name: "Wohn", kind: "RESIDENTIAL" }),
];

const LOCATIONS: LocationDto[] = [
  location({ id: "loc-hq", name: "HQ", kind: "HQ", cityId: "c-1", districtId: "d-centre", occupantCount: 3 }),
  location({ id: "loc-house", name: "House", kind: "HOME", cityId: "c-1", districtId: "d-resi" }),
];

/** Ray from above the building centre straight down (Y axis). */
function downwardRay(x: number, z: number, fromY = 80): THREE.Raycaster {
  const raycaster = new THREE.Raycaster();
  raycaster.set(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0));
  return raycaster;
}

describe("WorldScene", () => {
  it("applyPlan adds ground, roads and every plan building", () => {
    const scene = new WorldScene();
    const plan = computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: true });
    scene.applyPlan(plan);

    expect(scene.buildingCount()).toBe(plan.buildings.length);
    // Ground + at least one merged road mesh.
    let meshCount = 0;
    scene.root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh === true) meshCount += 1;
    });
    // ground + roads (+ maybe patches/decor) + buildings
    expect(meshCount).toBeGreaterThanOrEqual(2 + plan.buildings.length);
    scene.dispose();
  });

  it("pickBuildings hits real buildings under a downward ray", () => {
    const scene = new WorldScene();
    const plan = computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: false });
    scene.applyPlan(plan);

    const hq = plan.buildings.find((b) => b.key === "loc-hq");
    expect(hq).toBeDefined();
    const hit = scene.pickBuildings(downwardRay(hq?.x ?? 0, hq?.z ?? 0));
    expect(hit).not.toBeNull();
    expect(hit?.locationId).toBe("loc-hq");
    expect(hit?.key).toBe("loc-hq");
    scene.dispose();
  });

  it("pickBuildings never returns context filler", () => {
    const scene = new WorldScene();
    const plan = computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: true });
    scene.applyPlan(plan);
    const contextBuildings = plan.buildings.filter((b) => b.context);
    expect(contextBuildings.length).toBeGreaterThan(0);
    for (const ctx of contextBuildings) {
      const hit = scene.pickBuildings(downwardRay(ctx.x, ctx.z));
      // Either miss entirely, or hit a real building that happens to share
      // the column — but never the context building itself.
      if (hit !== null) {
        expect(hit.locationId).not.toBeNull();
        expect(hit.key).not.toBe(ctx.key);
      }
    }
    scene.dispose();
  });

  it("returns null for rays that miss every building", () => {
    const scene = new WorldScene();
    const plan = computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: false });
    scene.applyPlan(plan);
    // Far corner of the ground plane — no lots there.
    expect(scene.pickBuildings(downwardRay(230, 230))).toBeNull();
    scene.dispose();
  });

  it("reconcile removes deleted locations and keeps unchanged ones", () => {
    const scene = new WorldScene();
    const planA = computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: false });
    scene.applyPlan(planA);
    expect(scene.buildingCount()).toBe(planA.buildings.length);

    const planB = computeLayout({
      districts: DISTRICTS,
      locations: LOCATIONS.filter((l) => l.id !== "loc-house"),
      includeContext: false,
    });
    scene.applyPlan(planB);
    expect(scene.buildingCount()).toBe(planB.buildings.length);
    expect(planB.buildings.some((b) => b.key === "loc-house")).toBe(false);

    // Re-adding restores it.
    scene.applyPlan(computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: false }));
    expect(scene.buildingMeshes().has("loc-house")).toBe(true);
    scene.dispose();
  });

  it("setSelected/setHovered only change emissive on the targeted mesh", () => {
    const scene = new WorldScene();
    const plan = computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: false });
    scene.applyPlan(plan);

    scene.setSelected("loc-hq");
    const hq = scene.buildingMeshes().get("loc-hq");
    const house = scene.buildingMeshes().get("loc-house");
    expect(hq).toBeDefined();
    expect(house).toBeDefined();
    const hqMat = hq?.material as THREE.MeshStandardMaterial;
    const houseMat = house?.material as THREE.MeshStandardMaterial;
    expect(hqMat.emissive.getHex()).toBe(0x2a4a66);
    expect(houseMat.emissive.getHex()).toBe(0x000000);

    scene.setSelected(null);
    scene.setHovered("loc-house");
    expect(hqMat.emissive.getHex()).toBe(0x000000);
    expect(houseMat.emissive.getHex()).toBe(0x152a3a);

    scene.setHovered(null);
    expect(houseMat.emissive.getHex()).toBe(0x000000);
    scene.dispose();
  });

  it("anchorFor returns footprint-aware positions for real locations only", () => {
    const scene = new WorldScene();
    const plan = computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: true });
    scene.applyPlan(plan);
    const anchor = scene.anchorFor("loc-hq");
    expect(anchor).not.toBeNull();
    expect(anchor?.w).toBeGreaterThan(0);
    expect(anchor?.d).toBeGreaterThan(0);
    expect(scene.anchorFor("no-such-id")).toBeNull();
    scene.dispose();
  });

  it("building meshes carry selectable/locationId userData", () => {
    const plan = computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: true });
    const real = plan.buildings.find((b) => b.locationId !== null);
    const ctx = plan.buildings.find((b) => b.context);
    expect(real).toBeDefined();
    expect(ctx).toBeDefined();
    const realMesh = buildBuildingMesh(real as NonNullable<typeof real>);
    const ctxMesh = buildBuildingMesh(ctx as NonNullable<typeof ctx>);
    expect(realMesh.userData.selectable).toBe(true);
    expect(realMesh.userData.locationId).toBe(real?.locationId);
    expect(ctxMesh.userData.selectable).toBe(false);
    expect(ctxMesh.userData.locationId).toBeNull();
    realMesh.geometry.dispose();
    (realMesh.material as THREE.Material).dispose();
    ctxMesh.geometry.dispose();
    (ctxMesh.material as THREE.Material).dispose();
  });

  it("dispose() empties the scene without throwing", () => {
    const scene = new WorldScene();
    scene.applyPlan(computeLayout({ districts: DISTRICTS, locations: LOCATIONS, includeContext: true }));
    expect(scene.buildingCount()).toBeGreaterThan(0);
    scene.dispose();
    expect(scene.buildingCount()).toBe(0);
    // Second dispose is a no-op.
    scene.dispose();
  });
});
