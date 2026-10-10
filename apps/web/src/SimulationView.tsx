/**
 * Three.js view of the simulated world — Phase 1 explorable environment.
 *
 * Districts are laid out spatially:
 *   • City centre : central crossroads with public buildings
 *   • Residential : houses and apartment blocks
 *   • Business    : offices and shops
 *   • Village     : rural settlement with scattered houses
 *   • Public spaces: parks, plazas, green areas
 *
 * Every location/building is positioned according to its district.
 * Agents have recognizable silhouettes that change colour with state.
 * Selection highlights and info panels are supported.
 *
 * The view polls /simulation/state and refreshes on the SSE event stream,
 * so it can never disagree with the engine.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { API_BASE, api } from "./api.js";

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

const STATE_COLORS: Record<string, number> = {
  IDLE: 0x94a3b8,
  ONLINE: 0x14b8a6,
  WORKING: 0x22c55e,
  THINKING: 0x3b82f6,
  WAITING: 0xeab308,
  SLEEPING: 0x6366f1,
  TRAVELING: 0xf59e0b,
  RESTING: 0xa78bfa,
  SOCIALIZING: 0xec4899,
  OFFLINE: 0x475569,
  PAUSED: 0x64748b,
  ERROR: 0xef4444,
};

const DISTRICT_LAYOUT: Record<string, { x: number; z: number; radius: number }> = {
  CITY_CENTRE: { x: 0, z: 0, radius: 0 },
  RESIDENTIAL: { x: -20, z: 0, radius: 12 },
  BUSINESS: { x: 20, z: 0, radius: 12 },
  VILLAGE: { x: 0, z: -20, radius: 15 },
  PUBLIC: { x: 0, z: 20, radius: 8 },
};

const DISTRICT_COLORS: Record<string, number> = {
  RESIDENTIAL: 0xffe0b2,
  BUSINESS: 0xcaf0f8,
  VILLAGE: 0xbbdefb,
  PUBLIC: 0xf4cccc,
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

interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  districtGroups: Map<string, THREE.Group>;
  locationGroup: THREE.Group;
  agentGroup: THREE.Group;
  locationMeshes: Map<string, THREE.Mesh>;
  agentMeshes: Map<string, THREE.Mesh>;
  positions: Map<string, { x: number; z: number; district: string }>;
  yaw: number;
}

function disposeMesh(group: THREE.Group, mesh: THREE.Mesh): void {
  group.remove(mesh);
  mesh.geometry.dispose();
  const material = mesh.material;
  if (Array.isArray(material)) material.forEach((m) => m.dispose());
  else material.dispose();
}

export function SimulationView({ token }: { token: string }): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneContext | null>(null);
  const [state, setState] = useState<SimulationState | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [districts, setDistricts] = useState<DistrictRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentSummary | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const sim = await api.get<SimulationState>("/simulation/state");
      setState(sim.data);
      const snapshot = await api.get<{ locations: LocationRow[]; districts: DistrictRow[] }>("/world/snapshot");
      setLocations(snapshot.data.locations);
      setDistricts(snapshot.data.districts ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Create the renderer exactly once.
  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;
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

    const ctx: SceneContext = {
      scene,
      camera,
      renderer,
      districtGroups,
      locationGroup,
      agentGroup,
      locationMeshes: new Map(),
      agentMeshes: new Map(),
      positions: new Map(),
      yaw: 0,
    };
    sceneRef.current = ctx;

    let frame = 0;
    const render = (): void => {
      const dt = Math.min(0.1, clock.getDelta());
      animateCamera();
      for (const mesh of ctx.agentMeshes.values()) {
        const target = mesh.userData.target as THREE.Vector3 | undefined;
        if (target !== undefined) mesh.position.lerp(target, Math.min(1, dt * 4));
      }
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

    // Mouse drag for orbit control.
    let isDragging = false;
    let lastMouseX = 0;
    let lastMouseY = 0;

    const onMouseDown = (e: MouseEvent): void => {
      isDragging = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    };
    const onMouseMove = (e: MouseEvent): void => {
      if (!isDragging) return;
      const deltaX = e.clientX - lastMouseX;
      const deltaY = e.clientY - lastMouseY;
      theta -= deltaX * 0.01;
      phi += deltaY * 0.01;
      phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      animateCamera();
    };
    const onMouseUp = (): void => {
      isDragging = false;
    };
    const onMouseWheel = (e: WheelEvent): void => {
      const scale = Math.exp(-e.deltaY * 0.001);
      radius *= scale;
      radius = Math.max(20, Math.min(80, radius));
      animateCamera();
    };
    mount.addEventListener("mousedown", onMouseDown);
    mount.addEventListener("mousemove", onMouseMove);
    mount.addEventListener("mouseup", onMouseUp);
    // "mousewheel" / "DOMMouseScroll" are legacy non-standard events absent from
    // HTMLElementEventMap, so the typed handler is cast to a generic listener.
    mount.addEventListener("mousewheel", onMouseWheel as EventListener);
    mount.addEventListener("DOMMouseScroll", onMouseWheel as EventListener);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      mount.removeEventListener("mousedown", onMouseDown);
      mount.removeEventListener("mousemove", onMouseMove);
      mount.removeEventListener("mouseup", onMouseUp);
      mount.removeEventListener("mousewheel", onMouseWheel as EventListener);
      mount.removeEventListener("DOMMouseScroll", onMouseWheel as EventListener);
      for (const mesh of ctx.locationMeshes.values()) disposeMesh(locationGroup, mesh);
      for (const mesh of ctx.agentMeshes.values()) disposeMesh(agentGroup, mesh);
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, []);

  // Reconcile scene objects with the latest simulation data.
  useEffect(() => {
    const ctx = sceneRef.current;
    if (ctx === null) return;

    // Organize locations by district.
    const locationsByDistrict: Map<string, LocationRow[]> = new Map();
    for (const location of locations) {
      const did = location.districtId ?? "PUBLIC";
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
          ctx.locationGroup.add(mesh);
          ctx.locationMeshes.set(location.id, mesh);
        }
        mesh.position.set(x, 0, z);
      });
    });

    // Remove stale location meshes.
    for (const [id, mesh] of ctx.locationMeshes) {
      if (!locations.some((location) => location.id === id)) {
        disposeMesh(ctx.locationGroup, mesh);
        ctx.locationMeshes.delete(id);
        ctx.positions.delete(id);
      }
    }

    // Position agents with recognizable silhouettes.
    const agents = state?.agents ?? [];
    const perLocation: Map<string, number> = new Map();

    for (const agent of agents) {
      const base = agent.locationId === null
        ? { x: 0, z: 0, district: "PUBLIC" }
        : ctx.positions.get(agent.locationId);

      let target: { x: number; z: number; district: string };
      if (base === undefined) {
        target = { x: 0, z: 0, district: "PUBLIC" };
      } else {
        const slot = perLocation.get(agent.locationId as string) ?? 0;
        perLocation.set(agent.locationId as string, slot + 1);
        target = {
          x: base.x + Math.cos(slot * 1.3) * 1.2,
          z: base.z + Math.sin(slot * 1.3) * 1.2,
          district: base.district,
        };
      }

      // Agent silhouette: different shapes based on roleKey for distinction.
      let mesh = ctx.agentMeshes.get(agent.id);
      if (mesh === undefined) {
        const role = agent.roleKey ?? "AGENT";
        const stateColor = STATE_COLORS[agent.state] ?? 0x94a3b8;

        // Create a recognizable agent shape based on roleKey hash.
        const hash = role.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        const shapeType = hash % 4;

        let geometry: THREE.BufferGeometry;
        if (shapeType === 0) {
          // Human-like silhouette: box with tapered top
          geometry = new THREE.BoxGeometry(0.5, 1.6, 0.4);
        } else if (shapeType === 1) {
          // Rounded agent
          geometry = new THREE.SphereGeometry(0.4, 16, 16);
        } else if (shapeType === 2) {
          // Tall agent
          geometry = new THREE.CylinderGeometry(0.25, 0.25, 1.5, 24);
        } else {
          // Short/stooped agent
          geometry = new THREE.BoxGeometry(0.4, 1, 0.4);
        }

        mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: stateColor }),
        );
        // Add a simple "head" or identifier feature.
        if (shapeType === 0) {
          const headGeom = new THREE.SphereGeometry(0.15, 8, 8);
          const head = new THREE.Mesh(headGeom, new THREE.MeshStandardMaterial({ color: stateColor }));
          head.position.set(0, 1.55, 0);
          mesh.add(head);
        }
        ctx.agentGroup.add(mesh);
        ctx.agentMeshes.set(agent.id, mesh);
      }
      mesh.position.set(target.x, 1.4, target.z);

      // Color by state.
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color.setHex(STATE_COLORS[agent.state] ?? 0x94a3b8);
    }

    // Remove stale agent meshes.
    for (const [id, mesh] of ctx.agentMeshes) {
      if (!agents.some((agent) => agent.id === id)) {
        disposeMesh(ctx.agentGroup, mesh);
        ctx.agentMeshes.delete(id);
      }
    }
  }, [state, locations]);

  // Initial load + a slow safety poll.
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(interval);
  }, [load]);

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

return (
    <div className="grid gap-4 lg:grid-cols-6">
      {error !== null && (
        <p className="lg:col-span-6 mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>
      )}
      {/* Three.js world viewport (spanning 4 columns on lg) */}
      <div className="lg:col-span-4">
        <div className="rounded border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div ref={mountRef} className="h-[600px] w-full bg-[#0b1020]" />
          <div className="mt-2 text-xs text-gray-400">
            <span className="mr-2">W: {state?.world?.name ?? "—"}</span>
            <span>S: {state?.phase ?? "—"}</span>
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
                const locInfo = agent.locationId
                  ? `${agent.locationId.substring(0, 8)}…`
                  : "— unassigned";
                return (
                  <li
                    key={agent.id}
                    className="p-3 rounded border border-gray-200 cursor-pointer hover:border-blue-500 transition-colors"
                    onMouseOver={() => setSelectedAgent(agent)}
                    onMouseOut={() => setSelectedAgent(null)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${agent.state === "WORKING" ? "bg-green-100 text-green-800" : agent.state === "IDLE" ? "bg-gray-200 text-gray-700" : agent.state === "SLEEPING" ? "bg-blue-100 text-blue-800" : "bg-gray-200 text-gray-700"}`}>
                          {agent.state.substring(0, 3)}
                        </span>
                        <span className="font-medium text-gray-800">{agent.name}</span>
                      </div>
                      <span className="text-gray-400 text-xs">{locInfo}</span>
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
          className="p-4 rounded border border-gray-300 bg-gray-50 max-h-40 overflow-y-auto"
          style={{ display: selectedAgent !== null ? "block" : "none" }}
        >
          <h3 className="mb-2 text-sm font-medium text-gray-700">Inspector</h3>
          {selectedAgent !== null ? (
            <>
              <p className="text-xs text-gray-500">Name: {selectedAgent.name}</p>
              <p className="text-xs text-gray-500">Role: {selectedAgent.roleKey}</p>
              <p className="text-xs text-gray-500">State: {selectedAgent.state}</p>
              <p className="text-xs text-gray-500">Title: {selectedAgent.title}</p>
              {selectedAgent.locationId && (
                <p className="text-xs text-gray-500">Location: {selectedAgent.locationId}</p>
              )}
              {!selectedAgent.locationId && (
                <p className="text-xs text-gray-500">Location: — unassigned</p>
              )}
            </>
          ) : (
            <p className="text-xs text-gray-400">Click an agent or building to inspect.</p>
          )}
        </div>
      </div>
    </div>
  );
}
