/**
 * Three.js view of the simulated world — explorable environment with
 * districts, procedural 3D agent characters, and buildings.
 *
 * Districts are laid out spatially:
 *   • City centre : central crossroads with public buildings
 *   • Residential : houses and apartment blocks
 *   • Business    : offices and shops
 *   • Village     : rural settlement with scattered houses
 *   • Public spaces: parks, plazas, green areas
 *
 * Every location/building is positioned according to its district. Agents
 * render as recognizable human characters (see world/characterFactory.ts)
 * with deterministic identities derived from their stable agent ids.
 * Selection uses raycasting with character-over-building priority and is
 * shown in the shared inspector panel.
 *
 * The view polls /simulation/state and refreshes on the SSE event stream,
 * so it can never disagree with the engine. Character removals only happen
 * after a successful fetch confirms the id is gone — a failed fetch keeps
 * the previous scene intact instead of deleting everything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { API_BASE, api } from "./api.js";
import { stateColorHex } from "./world/characterAppearance.js";
import {
  FALLBACK_CENTER,
  FALLBACK_SPREAD,
  clearanceForKind,
  isWalkableKind,
  placeAgents,
  type BuildingAnchor,
  type PlacedAgent,
} from "./world/characterPlacement.js";
import {
  CharacterManager,
  pickSelection,
  type SelectionPick,
} from "./world/characterManager.js";
import {
  LABEL_ANCHOR_HEIGHT,
  disposeSharedCaches,
  findCharacterAgentId,
} from "./world/characterFactory.js";
import type {
  AgentDirectoryDto,
  CompanyDirectoryDto,
} from "./world/types.js";

interface AgentSummary {
  id: string;
  name: string;
  roleKey: string;
  title: string;
  state: string;
  locationId: string | null;
  activity: { id: string; type: string; status: string; startTime: string; expectedEndTime: string | null } | null;
  needs: Record<string, number>;
  critical: string[];
}

interface SimulationState {
  world: { id: string; name: string; status: string; timeScale: number; timeOffsetMinutes: number; lastTickAt: string | null };
  simulatedNow: string;
  wallNow: string;
  phase: string;
  engine: { heartbeatRunning: boolean; busy: boolean; tickIntervalMs: number };
  counts: { agents: number; activeActivities: number; criticalNeeds: number };
  agents: AgentSummary[];
}

interface LocationRow {
  id: string;
  name: string;
  kind: string;
  cityName: string;
  districtId: string | null;
  capacity: number | null;
  occupantCount: number;
}

interface DistrictRow {
  id: string;
  cityId: string;
  cityName: string;
  name: string;
  kind: string;
  description: string | null;
  locationCount: number;
}

type Selection =
  | { kind: "agent"; id: string }
  | { kind: "building"; id: string }
  | null;

const DISTRICT_LAYOUT: Record<string, { x: number; z: number; radius: number }> = {
  CITY_CENTRE: { x: 0, z: 0, radius: 0 },
  RESIDENTIAL: { x: -20, z: 0, radius: 12 },
  BUSINESS: { x: 20, z: 0, radius: 12 },
  VILLAGE: { x: 0, z: -20, radius: 15 },
  PUBLIC: { x: 0, z: 20, radius: 8 },
};

const DISTRICT_COLORS: Record<string, number> = {
  CITY_CENTRE: 0xc7d2fe,
  RESIDENTIAL: 0xffe0b2,
  BUSINESS: 0xcaf0f8,
  COMMERCIAL: 0xcaf0f8,
  VILLAGE: 0xbbdefb,
  PUBLIC: 0xf4cccc,
  INDUSTRIAL: 0xd6d3d1,
};

// Fallback used when a district id is not in the layout table. A literal (not an
// indexed lookup) so `noUncheckedIndexedAccess` cannot make it `undefined`.
const DEFAULT_DISTRICT_LAYOUT = { x: 0, z: 20, radius: 8 };

const RELOAD_EVENTS = [
  "WORLD_STATUS_CHANGED",
  "WORLD_TICK",
  "AGENT_STATE_CHANGED",
  "AGENT_ACTIVITY_STARTED",
  "AGENT_ACTIVITY_COMPLETED",
  "AGENT_GOAL_CREATED",
  "AGENT_GOAL_UPDATED",
  "AGENT_GOAL_COMPLETED",
  "LOCATION_CHANGED",
];

/** Vertical centre offset per building geometry so nothing sinks into the ground. */
function buildingGroundOffset(kind: string): number {
  switch (kind) {
    case "HOUSE":
    case "APARTMENT":
      return 1.75;
    case "SHOP":
      return 1.5;
    case "OFFICE":
      return 2.5;
    case "PUBLIC_SPACE":
    case "PARK":
      return 0.6;
    case "PLATZ":
    case "PLAZA":
      return 0.25;
    case "CHURCH":
    case "GOVERNMENT":
      return 3;
    default:
      return 1;
  }
}

/** Cap on simultaneously visible name labels (selected/hovered always win). */
const MAX_LABELS = 120;
/** Beyond this squared distance, labels are hidden when over the cap. */
const NEAR_SQ = 30 * 30;

function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  districtGroups: Map<string, THREE.Group>;
  locationGroup: THREE.Group;
  agentGroup: THREE.Group;
  locationMeshes: Map<string, THREE.Mesh>;
  agentManager: CharacterManager;
  positions: Map<string, { x: number; z: number; district: string }>;
  labelLayer: HTMLDivElement;
  labelPool: Map<string, HTMLDivElement>;
  labelText: Map<string, string>;
  selected: Selection;
  hoveredAgentId: string | null;
  selectedBuildingMesh: THREE.Mesh | null;
  agents: AgentSummary[];
  time: number;
  lastHoverCheck: number;
}

function disposeMesh(group: THREE.Group, mesh: THREE.Mesh): void {
  group.remove(mesh);
  mesh.geometry.dispose();
  const material = mesh.material;
  if (Array.isArray(material)) material.forEach((m) => m.dispose());
  else material.dispose();
}

function setBuildingEmissive(mesh: THREE.Mesh | null, hex: number): void {
  if (mesh === null) return;
  const material = mesh.material;
  if (Array.isArray(material)) {
    for (const m of material) {
      if (m instanceof THREE.MeshStandardMaterial) m.emissive.setHex(hex);
    }
  } else if (material instanceof THREE.MeshStandardMaterial) {
    material.emissive.setHex(hex);
  }
}

export function SimulationView({ token }: { token: string }): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneContext | null>(null);
  const [state, setState] = useState<SimulationState | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [districts, setDistricts] = useState<DistrictRow[]>([]);
  const [directory, setDirectory] = useState<Map<string, AgentDirectoryDto>>(new Map());
  const [companies, setCompanies] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const selectionRef = useRef<Selection>(null);

  const applySelection = useCallback((next: Selection): void => {
    const ctx = sceneRef.current;
    selectionRef.current = next;
    setSelection(next);
    if (ctx === null) return;
    // Clear previous highlights.
    for (const id of ctx.agentManager.ids()) ctx.agentManager.setHighlight(id, "none");
    setBuildingEmissive(ctx.selectedBuildingMesh, 0x000000);
    ctx.selectedBuildingMesh = null;
    ctx.selected = next;
    if (next?.kind === "agent") {
      ctx.agentManager.setHighlight(next.id, "selected");
    } else if (next?.kind === "building") {
      const mesh = ctx.locationMeshes.get(next.id) ?? null;
      ctx.selectedBuildingMesh = mesh;
      setBuildingEmissive(mesh, 0x334455);
    }
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const sim = await api.get<SimulationState>("/simulation/state");
      setState(sim.data);
      const snapshot = await api.get<{ locations: LocationRow[]; districts: DistrictRow[] }>("/world/snapshot");
      setLocations(snapshot.data.locations);
      setDistricts(snapshot.data.districts ?? []);
      setError(null);
    } catch (e) {
      // Keep the previous scene: a failed fetch must not delete characters.
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Best-effort enrichment (company, job). Never blocks the 3D scene.
  const loadDirectory = useCallback(async (): Promise<void> => {
    try {
      const [agentsRes, companiesRes] = await Promise.all([
        api.get<AgentDirectoryDto[]>("/agents"),
        api.get<CompanyDirectoryDto[]>("/companies"),
      ]);
      const dir = new Map<string, AgentDirectoryDto>();
      for (const row of agentsRes.data) {
        if (typeof row.id === "string") dir.set(row.id, row);
      }
      setDirectory(dir);
      const comps = new Map<string, string>();
      for (const row of companiesRes.data) {
        if (typeof row.id === "string" && typeof row.name === "string") comps.set(row.id, row.name);
      }
      setCompanies(comps);
    } catch {
      // Enrichment is optional; the inspector degrades to simulation fields.
    }
  }, []);

  // Create the renderer exactly once.
  useEffect(() => {
    const mount = mountRef.current;
    const labelLayer = labelLayerRef.current;
    if (mount === null || labelLayer === null) return;
    const width = mount.clientWidth || 640;
    const height = mount.clientHeight || 420;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1020);

    // District groups for spatial layout.
    const districtGroups: Map<string, THREE.Group> = new Map();
    ["CITY_CENTRE", "RESIDENTIAL", "BUSINESS", "VILLAGE", "PUBLIC"].forEach((did) => {
      const g = new THREE.Group();
      const layout = DISTRICT_LAYOUT[did] ?? DEFAULT_DISTRICT_LAYOUT;
      g.position.set(layout.x, 0, layout.z);
      scene.add(g);
      districtGroups.set(did, g);
    });

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 500);
    camera.position.set(0, 30, 40);
    camera.lookAt(0, 0, 0);

    // Camera orbit controls (manual, no dependency).
    let phi = Math.PI / 4;
    let theta = Math.PI * 2;
    let radius = 45;
    const animateCamera = (): void => {
      camera.position.x = radius * Math.sin(phi) * Math.cos(theta);
      camera.position.y = radius * Math.cos(phi);
      camera.position.z = radius * Math.sin(phi) * Math.sin(theta);
      camera.lookAt(0, 0, 0);
    };
    animateCamera();
    const clock = new THREE.Clock();

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const topLight = new THREE.DirectionalLight(0xffffff, 0.8);
    topLight.position.set(10, 20, 10);
    scene.add(topLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-10, -10, -10);
    scene.add(fillLight);

    // Add some ambient occlusion feel with a hemisphere light.
    const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x2c3e50, 0.3);
    scene.add(hemiLight);

    const locationGroup = new THREE.Group();
    const agentGroup = new THREE.Group();
    scene.add(locationGroup);
    scene.add(agentGroup);

    // Explicit fallback plaza for unassigned agents — a visible, intentional
    // waiting area so the fallback never reads as a workplace.
    const plazaGeo = new THREE.CircleGeometry(FALLBACK_SPREAD + 1.2, 40);
    const plazaMat = new THREE.MeshStandardMaterial({
      color: 0x1f2937,
      transparent: true,
      opacity: 0.55,
      roughness: 1,
    });
    const plaza = new THREE.Mesh(plazaGeo, plazaMat);
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(FALLBACK_CENTER.x, 0.01, FALLBACK_CENTER.z);
    scene.add(plaza);

    // Step 2 ground plane: a single static disc so buildings and characters
    // visibly stand on shared terrain instead of the void. Deliberately
    // plain — the other session's layout engine owns richer ground dressing.
    const groundGeo = new THREE.CircleGeometry(60, 64);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 1 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, 0);
    scene.add(ground);

    const ctx: SceneContext = {
      scene,
      camera,
      renderer,
      raycaster: new THREE.Raycaster(),
      pointer: new THREE.Vector2(),
      districtGroups,
      locationGroup,
      agentGroup,
      locationMeshes: new Map(),
      agentManager: new CharacterManager(agentGroup),
      positions: new Map(),
      labelLayer,
      labelPool: new Map(),
      labelText: new Map(),
      selected: null,
      hoveredAgentId: null,
      selectedBuildingMesh: null,
      agents: [],
      time: 0,
      lastHoverCheck: 0,
    };
    sceneRef.current = ctx;

    const projectTemp = new THREE.Vector3();

    const updateLabels = (): void => {
      const layerWidth = labelLayer.clientWidth || 1;
      const layerHeight = labelLayer.clientHeight || 1;
      const overCap = ctx.agents.length > MAX_LABELS;
      let shown = 0;
      for (const agent of ctx.agents) {
        const entry = ctx.agentManager.get(agent.id);
        let el = ctx.labelPool.get(agent.id);
        if (entry === undefined) {
          if (el !== undefined) {
            el.remove();
            ctx.labelPool.delete(agent.id);
            ctx.labelText.delete(agent.id);
          }
          continue;
        }
        if (el === undefined) {
          el = document.createElement("div");
          el.className = "sim-label";
          el.dataset.agentId = agent.id;
          labelLayer.appendChild(el);
          ctx.labelPool.set(agent.id, el);
        }
        const wanted = `${agent.name}|${agent.state}`;
        if (ctx.labelText.get(agent.id) !== wanted) {
          const dot = cssHex(stateColorHex(agent.state));
          el.innerHTML = "";
          const dotEl = document.createElement("span");
          dotEl.className = "sim-label-dot";
          dotEl.style.background = dot;
          const nameEl = document.createElement("span");
          nameEl.textContent = agent.name;
          el.appendChild(dotEl);
          el.appendChild(nameEl);
          el.title = agent.name;
          ctx.labelText.set(agent.id, wanted);
        }
        const isEmphasized =
          ctx.selected?.kind === "agent" && ctx.selected.id === agent.id
            ? true
            : ctx.hoveredAgentId === agent.id;
        el.classList.toggle("sim-label-em", isEmphasized);

        projectTemp.set(
          entry.group.position.x,
          LABEL_ANCHOR_HEIGHT,
          entry.group.position.z,
        );
        projectTemp.project(camera);
        const behind = projectTemp.z > 1;
        const x = (projectTemp.x * 0.5 + 0.5) * layerWidth;
        const y = (-projectTemp.y * 0.5 + 0.5) * layerHeight;
        const offscreen = x < -40 || x > layerWidth + 40 || y < -20 || y > layerHeight + 20;
        let hide = behind || offscreen;
        if (!hide && overCap && !isEmphasized) {
          const dx = entry.group.position.x - camera.position.x;
          const dz = entry.group.position.z - camera.position.z;
          if (dx * dx + dz * dz > NEAR_SQ || shown >= MAX_LABELS) hide = true;
        }
        if (hide) {
          el.style.display = "none";
        } else {
          shown += 1;
          el.style.display = "block";
          el.style.transform = `translate(-50%,-100%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
        }
      }
      // Drop pooled labels for agents that no longer exist.
      for (const [id, el] of ctx.labelPool) {
        if (!ctx.agentManager.get(id)) {
          el.remove();
          ctx.labelPool.delete(id);
          ctx.labelText.delete(id);
        }
      }
    };

    let frame = 0;
    const render = (): void => {
      const dt = Math.min(0.1, clock.getDelta());
      ctx.time += dt;
      animateCamera();
      ctx.agentManager.update(dt, ctx.time);
      updateLabels();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    const onResize = (): void => {
      const w = mount.clientWidth || width;
      const h = mount.clientHeight || height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    const setPointerFromEvent = (e: MouseEvent): void => {
      const rect = renderer.domElement.getBoundingClientRect();
      ctx.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ctx.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const pickAt = (e: MouseEvent): SelectionPick => {
      setPointerFromEvent(e);
      ctx.raycaster.setFromCamera(ctx.pointer, camera);
      const charHits = ctx.raycaster.intersectObjects(agentGroup.children, true);
      let charId: string | null = null;
      for (const hit of charHits) {
        charId = findCharacterAgentId(hit.object);
        if (charId !== null) break;
      }
      let buildingId: string | null = null;
      if (charId === null) {
        const buildingHits = ctx.raycaster.intersectObjects(locationGroup.children, false);
        const first = buildingHits[0];
        if (first !== undefined) {
          const data = first.object.userData as { kind?: unknown; locationId?: unknown };
          if (data.kind === "building" && typeof data.locationId === "string") {
            buildingId = data.locationId;
          }
        }
      }
      return pickSelection(charId, buildingId);
    };

    // Mouse drag for orbit control; click (no drag) for selection.
    let isDragging = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let downX = 0;
    let downY = 0;

    const onMouseDown = (e: MouseEvent): void => {
      isDragging = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      downX = e.clientX;
      downY = e.clientY;
    };
    const onMouseMove = (e: MouseEvent): void => {
      if (isDragging) {
        const deltaX = e.clientX - lastMouseX;
        const deltaY = e.clientY - lastMouseY;
        theta -= deltaX * 0.01;
        phi += deltaY * 0.01;
        phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        animateCamera();
        return;
      }
      const now = performance.now();
      if (now - ctx.lastHoverCheck < 60) return;
      ctx.lastHoverCheck = now;
      const pick = pickAt(e);
      const nextHover = pick.kind === "agent" ? pick.agentId : null;
      if (nextHover !== ctx.hoveredAgentId) {
        const prev = ctx.hoveredAgentId;
        ctx.hoveredAgentId = nextHover;
        setHoveredId(nextHover);
        if (prev !== null && !(ctx.selected?.kind === "agent" && ctx.selected.id === prev)) {
          ctx.agentManager.setHighlight(prev, "none");
        }
        if (
          nextHover !== null &&
          !(ctx.selected?.kind === "agent" && ctx.selected.id === nextHover)
        ) {
          ctx.agentManager.setHighlight(nextHover, "hover");
        }
      }
      renderer.domElement.style.cursor = nextHover !== null ? "pointer" : "default";
    };
    const onMouseUp = (e: MouseEvent): void => {
      const wasDragging = isDragging;
      isDragging = false;
      if (!wasDragging) return;
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved < 5) {
        const pick = pickAt(e);
        if (pick.kind === "none") {
          if (selectionRef.current !== null) applySelectionRef.current(null);
        } else if (pick.kind === "agent") {
          applySelectionRef.current({ kind: "agent", id: pick.agentId });
        } else {
          applySelectionRef.current({ kind: "building", id: pick.locationId });
        }
      }
    };
    const onMouseWheel = (e: WheelEvent): void => {
      const scale = Math.exp(-e.deltaY * 0.001);
      radius *= scale;
      radius = Math.max(20, Math.min(80, radius));
      animateCamera();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && selectionRef.current !== null) {
        applySelectionRef.current(null);
      }
    };
    // `applySelection` is stable (refs + setState only); mirror it for handlers.
    applySelectionRef.current = applySelection;
    mount.addEventListener("mousedown", onMouseDown);
    mount.addEventListener("mousemove", onMouseMove);
    mount.addEventListener("mouseup", onMouseUp);
    // "mousewheel" / "DOMMouseScroll" are legacy non-standard events absent from
    // HTMLElementEventMap, so the typed handler is cast to a generic listener.
    mount.addEventListener("mousewheel", onMouseWheel as EventListener);
    mount.addEventListener("DOMMouseScroll", onMouseWheel as EventListener);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      mount.removeEventListener("mousedown", onMouseDown);
      mount.removeEventListener("mousemove", onMouseMove);
      mount.removeEventListener("mouseup", onMouseUp);
      mount.removeEventListener("mousewheel", onMouseWheel as EventListener);
      mount.removeEventListener("DOMMouseScroll", onMouseWheel as EventListener);
      for (const mesh of ctx.locationMeshes.values()) disposeMesh(locationGroup, mesh);
      ctx.agentManager.clear();
      disposeSharedCaches();
      plazaGeo.dispose();
      plazaMat.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      labelLayer.innerHTML = "";
      sceneRef.current = null;
    };
    // Mount-only effect by design: the three.js scene is created once and all
    // live data flows through refs (sceneRef) and stable callbacks.
  }, []);

  // Mutable mirror of applySelection for three.js event handlers.
  const applySelectionRef = useRef<(next: Selection) => void>(() => undefined);
  useEffect(() => {
    applySelectionRef.current = applySelection;
  }, [applySelection]);

  // Reconcile scene objects with the latest simulation data.
  useEffect(() => {
    const ctx = sceneRef.current;
    if (ctx === null) return;
    // No successful fetch yet: keep the previous scene (loading or failed).
    if (state === null) return;

    // Organize locations by district KIND. Stored district ids are opaque
    // cuids, while DISTRICT_LAYOUT is keyed by kind ("RESIDENTIAL",
    // "BUSINESS", ...), so resolve through the district rows. Grouping by
    // raw id collapsed every district onto the PUBLIC fallback circle.
    const kindByDistrictId = new Map<string, string>();
    for (const district of districts) kindByDistrictId.set(district.id, district.kind);
    const districtKeyOf = (location: LocationRow): string => {
      if (location.districtId === null) return "PUBLIC";
      return kindByDistrictId.get(location.districtId) ?? "PUBLIC";
    };
    const locationsByDistrict: Map<string, LocationRow[]> = new Map();
    for (const location of locations) {
      const did = districtKeyOf(location);
      if (!locationsByDistrict.has(did)) locationsByDistrict.set(did, []);
      locationsByDistrict.get(did)!.push(location);
    }

    // Position each district group spatially.
    ctx.districtGroups.forEach((group, districtId) => {
      const layout = DISTRICT_LAYOUT[districtId];
      if (!layout) return;
      group.position.set(layout.x, 0, layout.z);
    });

    // Create/update location meshes per district.
    locationsByDistrict.forEach((districtLocations, districtId) => {
      const layout = DISTRICT_LAYOUT[districtId] ?? DEFAULT_DISTRICT_LAYOUT;
      const centerX = layout.x;
      const centerZ = layout.z;
      const radius = layout.radius || 8;

      districtLocations.forEach((location, index) => {
        const angle = (index / Math.max(1, districtLocations.length)) * Math.PI * 2;
        const x = centerX + Math.cos(angle) * radius;
        const z = centerZ + Math.sin(angle) * radius;
        ctx.positions.set(location.id, { x, z, district: districtId });

        let mesh = ctx.locationMeshes.get(location.id);
        if (mesh === undefined) {
          const kind = location.kind ?? "OTHER";
          let geometry: THREE.BufferGeometry;
          let color: number;

          // Choose geometry based on kind for recognizable building types.
          switch (kind) {
            case "HOUSE":
            case "APARTMENT":
              geometry = new THREE.CylinderGeometry(1.2, 1.2, 3.5, 24);
              color = 0xffe0b2; // warm residential
              break;
            case "SHOP":
              geometry = new THREE.BoxGeometry(4, 3, 3);
              color = 0xf59e0b; // market orange
              break;
            case "OFFICE":
              geometry = new THREE.BoxGeometry(6, 5, 4);
              color = 0x0ea5e9; // office blue
              break;
            case "PUBLIC_SPACE":
            case "PARK":
              geometry = new THREE.SphereGeometry(2, 24, 24, 8);
              color = 0x22c55e; // park green
              break;
            case "PLATZ":
            case "PLAZA":
              geometry = new THREE.BoxGeometry(5, 0.5, 5);
              color = 0x8b5cf6; // plaza purple
              break;
            case "CHURCH":
            // Fall through to PUBLIC
            case "GOVERNMENT":
              geometry = new THREE.CylinderGeometry(1.5, 1.5, 6, 24);
              color = 0x6366f1; // civic blue
              break;
            default:
              geometry = new THREE.CylinderGeometry(1.05, 1.05, 2, 24);
              color = DISTRICT_COLORS[districtId as keyof typeof DISTRICT_COLORS] ?? 0x94a3b8;
          }

          mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
              color,
              transparent: true,
              opacity: 0.9,
            }),
          );
          mesh.userData = { kind: "building", locationId: location.id };
          ctx.locationGroup.add(mesh);
          ctx.locationMeshes.set(location.id, mesh);
          // Re-apply selection highlight if this building is selected.
          if (ctx.selected?.kind === "building" && ctx.selected.id === location.id) {
            ctx.selectedBuildingMesh = mesh;
            setBuildingEmissive(mesh, 0x334455);
          }
        }
        mesh.position.set(x, buildingGroundOffset(location.kind ?? "OTHER"), z);
      });
    });

    // Remove stale location meshes.
    for (const [id, mesh] of ctx.locationMeshes) {
      if (!locations.some((location) => location.id === id)) {
        if (ctx.selectedBuildingMesh === mesh) ctx.selectedBuildingMesh = null;
        disposeMesh(ctx.locationGroup, mesh);
        ctx.locationMeshes.delete(id);
        ctx.positions.delete(id);
      }
    }

    // Reconcile 3D characters with the authoritative agent list.
    const agents = state.agents;
    const anchors = new Map<string, BuildingAnchor>();
    for (const [locationId, pos] of ctx.positions) {
      const row = locations.find((l) => l.id === locationId);
      anchors.set(locationId, {
        locationId,
        x: pos.x,
        z: pos.z,
        clearance: clearanceForKind(row?.kind ?? "OTHER"),
        walkable: isWalkableKind(row?.kind ?? "OTHER"),
      });
    }
    const placements = new Map<string, PlacedAgent>();
    for (const placed of placeAgents(agents, anchors)) {
      placements.set(placed.agentId, placed);
    }
    ctx.agentManager.sync(
      agents.map((a) => ({ id: a.id, state: a.state })),
      placements,
    );
    ctx.agents = agents;

    // If the selected agent was confirmed removed, clear the selection.
    if (ctx.selected?.kind === "agent" && !agents.some((a) => a.id === ctx.selected?.id)) {
      applySelectionRef.current(null);
    }
  }, [state, locations]);

  // Initial load + a slow safety poll.
  useEffect(() => {
    void load();
    void loadDirectory();
    const interval = window.setInterval(() => void load(), 5_000);
    const dirInterval = window.setInterval(() => void loadDirectory(), 15_000);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(dirInterval);
    };
  }, [load, loadDirectory]);

  // Live refresh from the event stream (throttled).
  useEffect(() => {
    const source = new EventSource(`${API_BASE}/events/stream?token=${encodeURIComponent(token)}`);
    let pending: number | undefined;
    const schedule = (): void => {
      if (pending !== undefined) return;
      pending = window.setTimeout(() => {
        pending = undefined;
        void load();
      }, 1_500);
    };
    for (const type of RELOAD_EVENTS) source.addEventListener(type, schedule);
    source.onopen = schedule;
    return () => {
      source.close();
      if (pending !== undefined) window.clearTimeout(pending);
    };
  }, [token, load]);

  const selectedAgent: AgentSummary | null =
    selection?.kind === "agent"
      ? (state?.agents.find((a) => a.id === selection.id) ?? null)
      : null;
  const selectedBuilding: LocationRow | null =
    selection?.kind === "building"
      ? (locations.find((l) => l.id === selection.id) ?? null)
      : null;
  const selectedDir: AgentDirectoryDto | null =
    selectedAgent !== null ? (directory.get(selectedAgent.id) ?? null) : null;
  const selectedLocationName: string | null =
    selectedAgent?.locationId !== null && selectedAgent?.locationId !== undefined
      ? (locations.find((l) => l.id === selectedAgent.locationId)?.name ?? selectedAgent.locationId)
      : null;
  const selectedCompanyName: string | null =
    selectedDir?.currentCompanyId !== null && selectedDir?.currentCompanyId !== undefined
      ? (companies.get(selectedDir.currentCompanyId) ?? selectedDir.currentCompanyId)
      : null;
  const selectedBuildingDistrict: string | null =
    selectedBuilding?.districtId !== null && selectedBuilding?.districtId !== undefined
      ? (districts.find((d) => d.id === selectedBuilding.districtId)?.name ?? selectedBuilding.districtId)
      : null;

  const selectFromList = (agent: AgentSummary): void => {
    applySelectionRef.current({ kind: "agent", id: agent.id });
  };

return (
    <div className="grid gap-4 lg:grid-cols-6">
      {error !== null && (
        <p className="lg:col-span-6 mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>
      )}
      {/* Three.js world viewport (spanning 4 columns on lg) */}
      <div className="lg:col-span-4">
        <div className="rounded border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="relative h-[600px] w-full bg-[#0b1020]" ref={mountRef}>
            <div
              ref={labelLayerRef}
              className="sim-label-layer pointer-events-none absolute inset-0 overflow-hidden"
            />
          </div>
          <div className="mt-2 flex items-center gap-3 px-2 pb-2 text-xs text-gray-400">
            <span>W: {state?.world?.name ?? "—"}</span>
            <span>S: {state?.phase ?? "—"}</span>
            <span>Agents: {state?.counts.agents ?? "—"}</span>
            <span className="ml-auto">Click a character or building to inspect · Esc to deselect</span>
          </div>
        </div>
      </div>

      {/* Right-side info panels (2 columns) */}
      <div className="lg:col-span-2 space-y-4">
        {/* District & Occupancy Panel */}
        <div>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">Districts</h2>
          {districts.length === 0 ? (
            <p className="text-sm text-gray-500">No districts defined. Add districts via the World tab.</p>
          ) : (
            <div className="space-y-2">
              {districts
                .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
                .map((district) => {
                  const grouped = locations.filter((l) => l.districtId === district.id);
                  const capacity = grouped.reduce((sum, l) => sum + (l.capacity ?? 0), 0);
                  const occupants = grouped.reduce((sum, l) => sum + l.occupantCount, 0);
                  const isAtCapacity = capacity > 0 && occupants >= capacity;
                  return (
                    <div
                      key={district.id}
                      className={`p-3 rounded border ${isAtCapacity ? "border-red-500" : "border-gray-300"} bg-gray-50`}
                    >
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="font-medium text-gray-700">
                          {district.name}
                          <span className="ml-1 text-gray-400">{district.cityName}</span>
                        </span>
                        <span className="text-gray-500">
                          {occupants}/{capacity || "∞"} places
                        </span>
                      </div>
                      <div className="mt-1 h-2 w-full rounded bg-gray-200 overflow-hidden">
                        <div
          className={`h-full ${capacity === 0 || occupants < capacity ? "bg-teal-500" : "bg-red-500"}`}
          style={{ width: capacity === 0 ? "0%" : `${Math.min(100, (occupants / capacity) * 100)}%` }}
        />
                      </div>
                      <ul className="mt-1 text-xs text-gray-500 grid grid-cols-2 gap-1">
                        {grouped.map((location) => (
                          <li key={location.id} className="flex justify-between">
                            <span>
                              {location.name}
                              <span className="ml-1 text-gray-400">{location.kind}</span>
                            </span>
                            <span>
                              {location.occupantCount}
                              {location.capacity !== null ? `/${location.capacity}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* Agent Panel */}
        <div>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">Agents</h2>
          {(state?.agents.length ?? 0) === 0 ? (
            <p className="text-sm text-gray-500">No agents in world.</p>
          ) : (
            <ul className="space-y-2 max-h-80 overflow-y-auto">
              {(state?.agents ?? []).map((agent) => {
                const locName = agent.locationId
                  ? (locations.find((l) => l.id === agent.locationId)?.name ?? `${agent.locationId.substring(0, 8)}…`)
                  : "— unassigned";
                const isSelected = selection?.kind === "agent" && selection.id === agent.id;
                const isHovered = hoveredId === agent.id;
                return (
                  <li
                    key={agent.id}
                    className={`p-3 rounded border cursor-pointer transition-colors ${isSelected ? "border-amber-500 bg-amber-50" : isHovered ? "border-blue-400" : "border-gray-200 hover:border-blue-500"}`}
                    onClick={() => selectFromList(agent)}
                    onMouseOver={() => setHoveredId(agent.id)}
                    onMouseOut={() => setHoveredId((prev) => (prev === agent.id ? null : prev))}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${agent.state === "WORKING" ? "bg-green-100 text-green-800" : agent.state === "IDLE" ? "bg-gray-200 text-gray-700" : agent.state === "SLEEPING" ? "bg-blue-100 text-blue-800" : "bg-gray-200 text-gray-700"}`}>
                          {agent.state.substring(0, 3)}
                        </span>
                        <span className="font-medium text-gray-800">{agent.name}</span>
                      </div>
                      <span className="text-gray-400 text-xs">{locName}</span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {agent.title}
                      {agent.activity !== null ? ` • ${agent.activity.type} (${agent.activity.status})` : ""}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Selected Agent / Building Info Panel */}
        <div
          id="inspector-panel"
          className="p-4 rounded border border-gray-300 bg-gray-50 max-h-80 overflow-y-auto"
        >
          <h3 className="mb-2 text-sm font-medium text-gray-700">Inspector</h3>
          {selectedAgent !== null ? (
            <>
              <p className="text-sm font-semibold text-gray-800">{selectedAgent.name}</p>
              <p className="mt-1 font-mono text-[11px] text-gray-400">id: {selectedAgent.id}</p>
              <p className="mt-1 text-xs text-gray-500">Role: {selectedAgent.roleKey}</p>
              <p className="text-xs text-gray-500">State: {selectedAgent.state}</p>
              <p className="text-xs text-gray-500">Title: {selectedAgent.title}</p>
              <p className="text-xs text-gray-500">
                Location: {selectedLocationName ?? "— unassigned (waiting plaza)"}
              </p>
              {selectedAgent.activity !== null ? (
                <p className="text-xs text-gray-500">
                  Activity: {selectedAgent.activity.type} ({selectedAgent.activity.status})
                </p>
              ) : (
                <p className="text-xs text-gray-500">Activity: —</p>
              )}
              <p className="text-xs text-gray-500">Company: {selectedCompanyName ?? "—"}</p>
              {selectedDir?.currentJob !== null && selectedDir?.currentJob !== undefined && (
                <p className="text-xs text-gray-500">Job: {selectedDir.currentJob}</p>
              )}
              <button
                onClick={() => applySelectionRef.current(null)}
                className="mt-2 text-xs text-blue-600 underline"
              >
                Deselect
              </button>
            </>
          ) : selectedBuilding !== null ? (
            <>
              <p className="text-sm font-semibold text-gray-800">{selectedBuilding.name}</p>
              <p className="mt-1 font-mono text-[11px] text-gray-400">id: {selectedBuilding.id}</p>
              <p className="mt-1 text-xs text-gray-500">Kind: {selectedBuilding.kind}</p>
              <p className="text-xs text-gray-500">
                District: {selectedBuildingDistrict ?? "—"}
              </p>
              <p className="text-xs text-gray-500">
                Occupancy: {selectedBuilding.occupantCount}
                {selectedBuilding.capacity !== null ? `/${selectedBuilding.capacity}` : ""}
              </p>
              <button
                onClick={() => applySelectionRef.current(null)}
                className="mt-2 text-xs text-blue-600 underline"
              >
                Deselect
              </button>
            </>
          ) : (
            <p className="text-xs text-gray-400">Click an agent or building to inspect.</p>
          )}
        </div>
      </div>
    </div>
  );
}
