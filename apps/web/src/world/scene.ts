/**
 * Pure three.js scene graph for the world view: builds and reconciles the
 * ground, roads, patches, buildings and decor from a `WorldLayoutPlan`.
 * No DOM and no renderer here — the test suite exercises it headless via
 * `Raycaster` against real meshes.
 */
import * as THREE from "three";
import {
  buildBuildingMesh,
  buildDecorMeshes,
  buildGround,
  buildPatchMesh,
  buildRoadMesh,
} from "./buildings.js";
import type { BuildingPlan, WorldLayoutPlan } from "./types.js";

export interface BuildingHit {
  key: string;
  locationId: string | null;
  plan: BuildingPlan;
}

export class WorldScene {
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();

  private ground: THREE.Mesh | null = null;
  private roads: THREE.Mesh | null = null;
  private patches: THREE.Mesh | null = null;
  private decor: THREE.Mesh[] = [];
  private readonly buildings = new Map<string, THREE.Mesh>();
  private readonly plans = new Map<string, BuildingPlan>();
  private selectedKey: string | null = null;
  private hoveredKey: string | null = null;

  constructor() {
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.add(this.root);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const sun = new THREE.DirectionalLight(0xfff4e0, 0.95);
    sun.position.set(60, 110, 40);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.35);
    fill.position.set(-40, 30, -50);
    this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0x9ec8ff, 0x3a4a32, 0.35));
  }

  /** Reconcile the scene against a new plan. Unchanged buildings keep meshes. */
  applyPlan(plan: WorldLayoutPlan): void {
    // Ground.
    if (this.ground === null || this.groundSize !== plan.groundSize) {
      this.disposeMesh(this.ground);
      this.ground = buildGround(plan.groundSize);
      this.groundSize = plan.groundSize;
      this.root.add(this.ground);
    }

    // Roads + patches: rebuilt whenever the plan reference changes (cheap
    // merge; the layout engine already keeps coordinates stable).
    this.disposeMesh(this.roads);
    const roadMesh = buildRoadMesh([...plan.arterials, ...plan.districts.flatMap((d) => d.roads)]);
    this.roads = roadMesh;
    if (roadMesh !== null) this.root.add(roadMesh);

    this.disposeMesh(this.patches);
    const patchMesh = buildPatchMesh(plan.districts.flatMap((d) => d.patches));
    this.patches = patchMesh;
    if (patchMesh !== null) this.root.add(patchMesh);

    for (const mesh of this.decor) this.disposeMesh(mesh);
    this.decor = buildDecorMeshes(plan.decor);
    for (const mesh of this.decor) this.root.add(mesh);

    // Buildings: diff by key.
    const wanted = new Map(plan.buildings.map((b) => [b.key, b] as const));
    for (const [key, mesh] of this.buildings) {
      const planFor = wanted.get(key);
      if (planFor === undefined) {
        this.root.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.buildings.delete(key);
        this.plans.delete(key);
        continue;
      }
      // Reposition only — geometry is keyed by archetype+footprint and the
      // layout engine keeps both stable for a given location.
      mesh.position.set(planFor.x, 0, planFor.z);
      mesh.rotation.y = planFor.rotation;
      mesh.visible = true;
    }
    for (const [key, planFor] of wanted) {
      if (!this.buildings.has(key)) {
        const mesh = buildBuildingMesh(planFor);
        this.buildings.set(key, mesh);
        this.plans.set(key, planFor);
        this.root.add(mesh);
      } else {
        this.plans.set(key, planFor);
      }
    }
    // Re-apply highlights after reconcile.
    this.applyHighlights();
  }

  /** Raycast pick over real (selectable) buildings only. */
  pickBuildings(raycaster: THREE.Raycaster): BuildingHit | null {
    // Headless (no renderer) never auto-updates matrices — do it here so
    // mesh.position/rotation are reflected in matrixWorld before the cast.
    this.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    for (const mesh of this.buildings.values()) {
      if (mesh.userData.selectable === true) meshes.push(mesh);
    }
    const hits = raycaster.intersectObjects(meshes, false);
    for (const hit of hits) {
      const object = hit.object;
      if (!(object instanceof THREE.Mesh)) continue;
      for (const [key, mesh] of this.buildings) {
        if (mesh === object) {
          const plan = this.plans.get(key);
          if (plan === undefined) continue;
          return { key, locationId: plan.locationId, plan };
        }
      }
    }
    return null;
  }

  setSelected(key: string | null): void {
    this.selectedKey = key;
    this.applyHighlights();
  }

  setHovered(key: string | null): void {
    this.hoveredKey = key;
    this.applyHighlights();
  }

  /** World position + height of a real location for agent anchoring. */
  anchorFor(locationId: string): { x: number; z: number; w: number; d: number } | null {
    for (const plan of this.plans.values()) {
      if (plan.locationId === locationId) {
        return { x: plan.x, z: plan.z, w: plan.footprint.w, d: plan.footprint.d };
      }
    }
    return null;
  }

  buildingCount(): number {
    return this.buildings.size;
  }

  /** Read-only view of live building meshes, keyed by plan key (tests + tooling). */
  buildingMeshes(): ReadonlyMap<string, THREE.Mesh> {
    return this.buildings;
  }

  private applyHighlights(): void {
    for (const [key, mesh] of this.buildings) {
      const material = mesh.material;
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (key === this.selectedKey) material.emissive.setHex(0x2a4a66);
      else if (key === this.hoveredKey) material.emissive.setHex(0x152a3a);
      else material.emissive.setHex(0x000000);
    }
  }

  private disposeMesh(mesh: THREE.Mesh | null): void {
    if (mesh === null) return;
    this.root.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  private groundSize = 0;

  dispose(): void {
    this.disposeMesh(this.ground);
    this.disposeMesh(this.roads);
    this.disposeMesh(this.patches);
    for (const mesh of this.decor) this.disposeMesh(mesh);
    this.decor = [];
    for (const mesh of this.buildings.values()) this.disposeMesh(mesh);
    this.buildings.clear();
    this.plans.clear();
    this.root.clear();
  }
}
