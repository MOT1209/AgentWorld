/**
 * Three.js view of the simulated world — a real city built from the layout
 * engine (world/layout.ts) and rendered through WorldScene (world/scene.ts).
 *
 * Locations become buildings on street lots inside their district's parcel;
 * districts get roads, plazas and parks; arterials tie the map together.
 * Agent characters (world/characterFactory.ts) stand in front of the buildings
 * they occupy. Selection is raycast (character over building) and shown in
 * the shared inspector panel.
 *
 * Data flows one way: /simulation/state + /world/snapshot (+ SSE) → layout
 * engine (sticky) → WorldScene reconcile. A failed fetch keeps the previous
 * scene; removals only happen after a successful fetch confirms the id is gone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { API_BASE, api } from "./api.js";
import { stateColorHex } from "./world/characterAppearance.js";
import {
  FALLBACK_CENTER,
  FALLBACK_SPREAD,
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
import {
  buildNavGraph,
  doorForBuilding,
  findRoute,
  graphSignature,
  type NavGraph,
  type NavPoint,
} from "./world/navigation.js";
import {
  MovementSystem,
  baseBehaviorFor,
  type BehaviorState,
} from "./world/agentMovement.js";
import { WorldLayoutEngine } from "./world/layout.js";
import { WorldScene } from "./world/scene.js";
import type {
  AgentDirectoryDto,
  CompanyDirectoryDto,
  DistrictDto,
  LocationDto,
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

type Selection =
  | { kind: "agent"; id: string }
  | { kind: "building"; id: string }
  | null;

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

/** Cap on simultaneously visible name labels (selected/hovered always win). */
const MAX_LABELS = 120;
/** Beyond this squared distance, labels are hidden when over the cap. */
const NEAR_SQ = 60 * 60;

function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  world: WorldScene;
  engine: WorldLayoutEngine;
  agentGroup: THREE.Group;
  agentManager: CharacterManager;
  /** Step 3: road-following walks, behavior states, pause/speed. */
  movement: MovementSystem;
  navGraph: NavGraph;
  navSignature: string;
  doors: Array<{ point: NavPoint; name: string | null; locationId: string }>;
  lastAuthKey: Map<string, string>;
  simPaused: boolean;
  simSpeed: number;
  demoStroll: boolean;
  labelLayer: HTMLDivElement;
  labelPool: Map<string, HTMLDivElement>;
  labelText: Map<string, string>;
  selected: Selection;
  hoveredAgentId: string | null;
  hoveredBuildingKey: string | null;
  agents: AgentSummary[];
  time: number;
  lastHoverCheck: number;
  worldId: string | null;
}

export function SimulationView({ token }: { token: string }): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneContext | null>(null);
  const [state, setState] = useState<SimulationState | null>(null);
  const [locations, setLocations] = useState<LocationDto[]>([]);
  const [districts, setDistricts] = useState<DistrictDto[]>([]);
  const [directory, setDirectory] = useState<Map<string, AgentDirectoryDto>>(new Map());
  const [companies, setCompanies] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const selectionRef = useRef<Selection>(null);
  // Mutable mirror of applySelection for three.js event handlers (declared
  // before the mount effect so the closure can close over it safely).
  const applySelectionRef = useRef<(next: Selection) => void>(() => undefined);

  const applySelection = useCallback((next: Selection): void => {
    const ctx = sceneRef.current;
    selectionRef.current = next;
    setSelection(next);
    if (ctx === null) return;
    for (const id of ctx.agentManager.ids()) ctx.agentManager.setHighlight(id, "none");
    ctx.selected = next;
    if (next?.kind === "agent") {
      ctx.agentManager.setHighlight(next.id, "selected");
      ctx.world.setSelected(null);
    } else if (next?.kind === "building") {
      // Real buildings use key === locationId (see BuildingPlan.key).
      ctx.world.setSelected(next.id);
      ctx.world.setHovered(null);
      ctx.hoveredBuildingKey = null;
    } else {
      ctx.world.setSelected(null);
    }
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const sim = await api.get<SimulationState>("/simulation/state");
      setState(sim.data);
      const snapshot = await api.get<{ locations: LocationDto[]; districts: DistrictDto[] }>("/world/snapshot");
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

  // Create the renderer + world scene exactly once.
  useEffect(() => {
    const mount = mountRef.current;
    const labelLayer = labelLayerRef.current;
    if (mount === null || labelLayer === null) return;
    const width = mount.clientWidth || 640;
    const height = mount.clientHeight || 420;

    const world = new WorldScene();
    const scene = world.scene;

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    camera.position.set(0, 90, 140);
    camera.lookAt(0, 0, 0);

    // Camera orbit controls (manual, no dependency).
    let phi = 1.05;
    let theta = Math.PI * 0.25;
    let radius = 160;
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

    const agentGroup = new THREE.Group();
    scene.add(agentGroup);

    const agentManager = new CharacterManager(agentGroup);
    const movement = new MovementSystem(
      (id) => agentManager.get(id),
      agentManager,
    );

    const ctx: SceneContext = {
      scene,
      camera,
      renderer,
      raycaster: new THREE.Raycaster(),
      pointer: new THREE.Vector2(),
      world,
      engine: new WorldLayoutEngine(),
      agentGroup,
      agentManager,
      movement,
      navGraph: { nodes: [], neighbors: [] },
      navSignature: "",
      doors: [],
      lastAuthKey: new Map(),
      simPaused: false,
      simSpeed: 1,
      demoStroll: false,
      labelLayer,
      labelPool: new Map(),
      labelText: new Map(),
      selected: null,
      hoveredAgentId: null,
      hoveredBuildingKey: null,
      agents: [],
      time: 0,
      lastHoverCheck: 0,
      worldId: null,
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
      // Walk/work poses override the idle pass for movers and workers.
      ctx.movement.update(dt, ctx.time);
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
      let buildingLocationId: string | null = null;
      if (charId === null) {
        const hit = ctx.world.pickBuildings(ctx.raycaster);
        if (hit !== null && hit.locationId !== null) buildingLocationId = hit.locationId;
      }
      return pickSelection(charId, buildingLocationId);
    };

    // Mouse drag for orbit control; click (no drag) for selection.
    let isDragging = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let downX = 0;
    let downY = 0;

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
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
        theta -= deltaX * 0.008;
        phi += deltaY * 0.008;
        phi = Math.max(0.15, Math.min(Math.PI / 2 - 0.05, phi));
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        animateCamera();
        return;
      }
      const now = performance.now();
      if (now - ctx.lastHoverCheck < 60) return;
      ctx.lastHoverCheck = now;
      setPointerFromEvent(e);
      ctx.raycaster.setFromCamera(ctx.pointer, camera);
      const charHits = ctx.raycaster.intersectObjects(agentGroup.children, true);
      let charId: string | null = null;
      for (const hit of charHits) {
        charId = findCharacterAgentId(hit.object);
        if (charId !== null) break;
      }
      const nextHover = charId;
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
      // Building hover (only when no character is under the cursor).
      const buildingHit = charId === null ? ctx.world.pickBuildings(ctx.raycaster) : null;
      const nextBuildingKey = buildingHit?.key ?? null;
      if (nextBuildingKey !== ctx.hoveredBuildingKey) {
        ctx.hoveredBuildingKey = nextBuildingKey;
        // Don't stomp the selected building's highlight.
        if (ctx.selected?.kind !== "building") ctx.world.setHovered(nextBuildingKey);
      }
      renderer.domElement.style.cursor =
        nextHover !== null || nextBuildingKey !== null ? "pointer" : "default";
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
      e.preventDefault();
      const scale = Math.exp(e.deltaY * 0.001);
      radius *= scale;
      radius = Math.max(40, Math.min(500, radius));
      animateCamera();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && selectionRef.current !== null) {
        applySelectionRef.current(null);
      }
    };
    const onContextMenu = (e: MouseEvent): void => e.preventDefault();
    // `applySelection` is stable (refs + setState only); mirror it for handlers.
    applySelectionRef.current = applySelection;
    mount.addEventListener("mousedown", onMouseDown);
    mount.addEventListener("mousemove", onMouseMove);
    mount.addEventListener("mouseup", onMouseUp);
    mount.addEventListener("wheel", onMouseWheel, { passive: false });
    mount.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      mount.removeEventListener("mousedown", onMouseDown);
      mount.removeEventListener("mousemove", onMouseMove);
      mount.removeEventListener("mouseup", onMouseUp);
      mount.removeEventListener("wheel", onMouseWheel);
      mount.removeEventListener("contextmenu", onContextMenu);
      ctx.agentManager.clear();
      ctx.movement.clear();
      ctx.world.dispose();
      disposeSharedCaches();
      plazaGeo.dispose();
      plazaMat.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      labelLayer.innerHTML = "";
      sceneRef.current = null;
    };
    // Mount-only effect by design: the three.js scene is created once and all
    // live data flows through refs (sceneRef) and stable callbacks.
  }, []);

  useEffect(() => {
    applySelectionRef.current = applySelection;
  }, [applySelection]);

  // Reconcile the layout + characters with the latest simulation data.
  useEffect(() => {
    const ctx = sceneRef.current;
    if (ctx === null) return;
    // No successful fetch yet: keep the previous scene (loading or failed).
    if (state === null) return;
    // New world → forget sticky parcels/lots.
    if (ctx.worldId !== state.world.id) {
      ctx.engine.reset();
      ctx.worldId = state.world.id;
    }

    // Layout engine: sticky parcels + lots; context filler on unused lots.
    const plan = ctx.engine.update({ districts, locations, includeContext: true });
    ctx.world.applyPlan(plan);

    // Fallback plaza follows the PUBLIC parcel so unassigned agents never
    // land on a building lot (the legacy circle constant is last resort).
    const publicParcel = plan.districts.find((d) => d.classification === "PUBLIC")?.parcel
      ?? plan.districts[0]?.parcel;
    const fallbackCenter = publicParcel !== undefined
      ? { x: publicParcel.x, z: publicParcel.z }
      : FALLBACK_CENTER;

    // Agent anchors come from the real building positions.
    const anchors = new Map<string, BuildingAnchor>();
    const walkableKinds = new Map<string, boolean>();
    for (const building of plan.buildings) {
      if (building.locationId === null) continue;
      anchors.set(building.locationId, {
        locationId: building.locationId,
        x: building.x,
        z: building.z,
        clearance: Math.max(building.footprint.w, building.footprint.d) / 2 + 1.2,
        walkable: isWalkableKind(building.kind),
      });
      walkableKinds.set(building.locationId, isWalkableKind(building.kind));
    }
    const placements = new Map<string, PlacedAgent>();
    for (const placed of placeAgents(state.agents, anchors, walkableKinds, fallbackCenter)) {
      placements.set(placed.agentId, placed);
    }
    ctx.agentManager.sync(
      state.agents.map((a) => ({ id: a.id, state: a.state })),
      placements,
    );
    ctx.agents = state.agents;

    // Navigation graph from the real roads + building doors (rebuilt only
    // when the road network changes; routes are computed per destination).
    const roads = [...plan.arterials, ...plan.districts.flatMap((d) => d.roads)];
    const doors: Array<{ point: NavPoint; name: string | null; locationId: string }> = [];
    const doorByLocation = new Map<string, NavPoint>();
    for (const building of plan.buildings) {
      if (building.locationId === null) continue;
      const door = doorForBuilding(building.x, building.z, building.rotation, building.footprint.d);
      doors.push({
        point: door,
        name: building.name,
        locationId: building.locationId,
      });
      if (!doorByLocation.has(building.locationId)) doorByLocation.set(building.locationId, door);
    }
    const signature = graphSignature(roads, doors.length);
    if (signature !== ctx.navSignature) {
      ctx.navGraph = buildNavGraph(
        roads,
        doors.map((d) => d.point),
      );
      ctx.navSignature = signature;
    }
    ctx.doors = doors;

    // Step 3 routing: an authoritative location change walks the roads
    // instead of easing through buildings. Already-settled agents keep the
    // cheap placement ease; failures hold position and warn (no retries).
    const seen = new Set<string>();
    for (const agent of state.agents) {
      seen.add(agent.id);
      ctx.movement.setBaseBehavior(agent.id, baseBehaviorFor(agent.state));
      const placement = placements.get(agent.id);
      const authKey = `${agent.locationId ?? "∅"}|${placement?.x.toFixed(2) ?? "∅"},${placement?.z.toFixed(2) ?? "∅"}`;
      if (
        placement === undefined ||
        placement.fallback ||
        agent.locationId === null
      ) {
        // Unassigned: Step-2 placement easing, never a walking route.
        ctx.lastAuthKey.set(agent.id, authKey);
        ctx.movement.cancelRoute(agent.id);
        continue;
      }
      if (ctx.lastAuthKey.get(agent.id) === authKey) continue; // keep current route (incl. demo)
      ctx.lastAuthKey.set(agent.id, authKey);
      const figure = ctx.agentManager.get(agent.id);
      const door = doorByLocation.get(agent.locationId);
      if (figure === undefined || door === undefined) {
        ctx.movement.cancelRoute(agent.id);
        continue;
      }
      const from = { x: figure.group.position.x, z: figure.group.position.z };
      const goal = { x: placement.x, z: placement.z };
      if (Math.hypot(from.x - goal.x, from.z - goal.z) <= 1) {
        // Already home (spawn or tiny drift): settle via placement ease.
        ctx.movement.cancelRoute(agent.id);
        ctx.agentManager.setTarget(agent.id, goal.x, goal.z);
        continue;
      }
      // allowFarStart: mid-ease positions may sit off-network; the first
      // leg then simply walks to the nearest road. Goals stay strict.
      const route = findRoute(ctx.navGraph, from, door, { allowFarStart: true });
      if (route.ok) {
        ctx.movement.startRoute(agent.id, [...route.waypoints, goal], {
          point: goal,
          name: locations.find((l) => l.id === agent.locationId)?.name ?? agent.locationId,
          demo: false,
        });
      } else {
        console.warn(`[sim] no walking route for ${agent.name} (${agent.id}): ${route.reason}`);
        ctx.movement.cancelRoute(agent.id);
        ctx.agentManager.setTarget(agent.id, from.x, from.z);
      }
    }
    // Confirmed deletions drop movers, keys, and base behaviors together.
    for (const id of [...ctx.lastAuthKey.keys()]) {
      if (!seen.has(id)) {
        ctx.lastAuthKey.delete(id);
        ctx.movement.remove(id);
      }
    }

    // If the selected agent was confirmed removed, clear the selection.
    if (ctx.selected?.kind === "agent" && !state.agents.some((a) => a.id === ctx.selected?.id)) {
      applySelectionRef.current(null);
    }
  }, [state, locations, districts]);

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
  const selectedBuilding: LocationDto | null =
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

  // Step 3 observability: local motion snapshot refreshed at 1 Hz (the 3D
  // loop itself never setStates per frame). Feeds the inspector + footer.
  const [motion, setMotion] = useState<
    Record<string, { behavior: BehaviorState; dest: string | null; demo: boolean }>
  >({});
  const [simUi, setSimUi] = useState({ paused: false, speed: 1, demo: false, movers: 0 });

  const selectedMotion =
    selection?.kind === "agent" ? motion[selection.id] : undefined;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const ctx = sceneRef.current;
      if (ctx === null || state === null) return;
      const next: Record<string, { behavior: BehaviorState; dest: string | null; demo: boolean }> = {};
      for (const agent of state.agents) {
        const dest = ctx.movement.destinationOf(agent.id);
        next[agent.id] = {
          behavior: ctx.movement.behaviorOf(agent.id),
          dest: dest?.name ?? null,
          demo: dest?.demo ?? false,
        };
      }
      setMotion((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      const snapshot = {
        paused: ctx.simPaused,
        speed: ctx.simSpeed,
        demo: ctx.demoStroll,
        movers: ctx.movement.moverCount(),
      };
      setSimUi((prev) => (JSON.stringify(prev) === JSON.stringify(snapshot) ? prev : snapshot));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  const togglePause = useCallback((): void => {
    const ctx = sceneRef.current;
    if (ctx === null) return;
    ctx.simPaused = !ctx.simPaused;
    ctx.movement.setPaused(ctx.simPaused);
    setSimUi((p) => ({ ...p, paused: ctx.simPaused }));
  }, []);

  const cycleSpeed = useCallback((): void => {
    const ctx = sceneRef.current;
    if (ctx === null) return;
    ctx.simSpeed = ctx.simSpeed >= 4 ? 1 : ctx.simSpeed * 2;
    ctx.movement.setTimeScale(ctx.simSpeed);
    setSimUi((p) => ({ ...p, speed: ctx.simSpeed }));
  }, []);

  const toggleDemo = useCallback((): void => {
    const ctx = sceneRef.current;
    if (ctx === null) return;
    ctx.demoStroll = !ctx.demoStroll;
    setSimUi((p) => ({ ...p, demo: ctx.demoStroll }));
  }, []);

  // Explicit local demo, OFF in production: idle agents stroll between
  // nearby doors. Demo goals are labelled and never touch backend state.
  // NOTE: the agent list is read through a ref mirror so polling/SSE state
  // churn (new object identity every few seconds) can never starve this 4s
  // timer by tearing the effect down before it fires.
  const agentsRef = useRef<AgentSummary[]>([]);
  agentsRef.current = state?.agents ?? [];
  useEffect(() => {
    const timer = window.setInterval(() => {
      const ctx = sceneRef.current;
      if (ctx === null) return;
      const agents = agentsRef.current;
      if (!ctx.demoStroll || ctx.simPaused || ctx.doors.length === 0) return;
      const candidates = agents.filter(
        (a) => ctx.movement.behaviorOf(a.id) === "idle" && !ctx.movement.hasRoute(a.id),
      );
      for (const agent of candidates.slice(0, 2)) {
        const figure = ctx.agentManager.get(agent.id);
        if (figure === undefined) continue;
        const from = { x: figure.group.position.x, z: figure.group.position.z };
        const inRange = ctx.doors.filter((d) => {
          const dist = Math.hypot(d.point.x - from.x, d.point.z - from.z);
          return dist > 25 && dist < 130;
        });
        if (inRange.length === 0) continue;
        const pick = inRange[Math.floor(Math.random() * inRange.length)];
        if (pick === undefined) continue;
        const route = findRoute(ctx.navGraph, from, pick.point, { maxSnapTo: 25 });
        if (!route.ok || route.distance < 8) continue;
        ctx.movement.startRoute(agent.id, [...route.waypoints, pick.point], {
          point: pick.point,
          name: pick.name !== null ? `Stroll near ${pick.name}` : "Local stroll",
          demo: true,
        });
      }
    }, 4000);
    return () => window.clearInterval(timer);
    // [] — stable by design (reads agentsRef); see NOTE above.
  }, []);

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
          <div className="flex items-center gap-2 px-2 pt-2 text-xs">
            <span
              className={`inline-block h-2 w-2 rounded-full ${state?.world?.status === "RUNNING" ? "bg-green-500" : "bg-gray-400"}`}
              title={`World status: ${state?.world?.status ?? "—"}`}
            />
            <span className="text-gray-500">World: {state?.world?.status ?? "—"}</span>
            <button
              onClick={togglePause}
              className="rounded border border-gray-300 bg-gray-50 px-2 py-0.5 text-gray-700 hover:border-gray-500"
            >
              {simUi.paused ? "▶ Resume motion" : "⏸ Pause motion"}
            </button>
            <button
              onClick={cycleSpeed}
              className="rounded border border-gray-300 bg-gray-50 px-2 py-0.5 text-gray-700 hover:border-gray-500"
            >
              Speed {simUi.speed}x
            </button>
            <button
              onClick={toggleDemo}
              title="Local demo only: idle agents stroll nearby. Never a backend task."
              className={`rounded border px-2 py-0.5 hover:border-gray-500 ${simUi.demo ? "border-amber-500 bg-amber-50 text-amber-800" : "border-gray-300 bg-gray-50 text-gray-700"}`}
            >
              Demo stroll: {simUi.demo ? "on" : "off"}
            </button>
            <span className="text-gray-500">{simUi.movers} walking</span>
            {simUi.demo && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">DEMO</span>
            )}
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
                .slice()
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
              {selectedMotion !== undefined && (
                <p className="text-xs text-gray-500">
                  Motion: {selectedMotion.behavior}
                  {selectedMotion.dest !== null ? ` → ${selectedMotion.dest}` : ""}
                  {selectedMotion.demo ? " (local demo)" : ""}
                </p>
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
              {selectedBuilding.address !== null && selectedBuilding.address !== undefined && (
                <p className="text-xs text-gray-500">Address: {selectedBuilding.address}</p>
              )}
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
