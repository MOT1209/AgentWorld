/**
 * Minimal three.js view of the simulated world.
 *
 * The scene is a faithful, deliberately low-poly projection of the SAME data the
 * API serves: every location is a marker arranged on a ring, every agent is a
 * sphere that sits at its current location and changes colour with its state.
 * Nothing here is a source of truth -- the view polls /simulation/state and
 * refreshes on the SSE event stream, so it can never disagree with the engine.
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
  occupantCount: number;
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

const KIND_COLORS: Record<string, number> = {
  HQ: 0x2563eb,
  OFFICE: 0x0ea5e9,
  BANK: 0x16a34a,
  MARKET: 0xf59e0b,
  PUBLIC_SPACE: 0x8b5cf6,
  RESTAURANT: 0xdb2777,
};

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
  locationGroup: THREE.Group;
  agentGroup: THREE.Group;
  locationMeshes: Map<string, THREE.Mesh>;
  agentMeshes: Map<string, THREE.Mesh>;
  positions: Map<string, THREE.Vector3>;
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const sim = await api.get<SimulationState>("/simulation/state");
      setState(sim.data);
      const snapshot = await api.get<{ locations: LocationRow[] }>("/world/snapshot");
      setLocations(snapshot.data.locations);
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
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 500);
    camera.position.set(0, 16, 22);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const light = new THREE.DirectionalLight(0xffffff, 1.1);
    light.position.set(10, 18, 12);
    scene.add(light);
    const grid = new THREE.GridHelper(40, 40, 0x2a3550, 0x18203a);
    scene.add(grid);

    const locationGroup = new THREE.Group();
    const agentGroup = new THREE.Group();
    scene.add(locationGroup);
    scene.add(agentGroup);

    const ctx: SceneContext = {
      scene,
      camera,
      renderer,
      locationGroup,
      agentGroup,
      locationMeshes: new Map(),
      agentMeshes: new Map(),
      positions: new Map(),
      yaw: 0,
    };
    sceneRef.current = ctx;

    const clock = new THREE.Clock();
    let frame = 0;
    const render = (): void => {
      const dt = Math.min(0.1, clock.getDelta());
      for (const mesh of ctx.agentMeshes.values()) {
        const target = mesh.userData.target as THREE.Vector3 | undefined;
        if (target !== undefined) mesh.position.lerp(target, Math.min(1, dt * 4));
      }
      ctx.yaw += dt * 0.06;
      locationGroup.rotation.y = ctx.yaw;
      agentGroup.rotation.y = ctx.yaw;
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

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
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

    const count = Math.max(1, locations.length);
    locations.forEach((location, index) => {
      const angle = (index / count) * Math.PI * 2;
      const position = new THREE.Vector3(Math.cos(angle) * 9, 0, Math.sin(angle) * 9);
      ctx.positions.set(location.id, position);
      let mesh = ctx.locationMeshes.get(location.id);
      if (mesh === undefined) {
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(1.05, 1.05, 0.6, 24),
          new THREE.MeshStandardMaterial({
            color: KIND_COLORS[location.kind] ?? 0x64748b,
            transparent: true,
            opacity: 0.9,
          }),
        );
        ctx.locationGroup.add(mesh);
        ctx.locationMeshes.set(location.id, mesh);
      }
      mesh.position.copy(position);
    });
    for (const [id, mesh] of ctx.locationMeshes) {
      if (!locations.some((location) => location.id === id)) {
        disposeMesh(ctx.locationGroup, mesh);
        ctx.locationMeshes.delete(id);
        ctx.positions.delete(id);
      }
    }

    const agents = state?.agents ?? [];
    const perLocation = new Map<string, number>();
    for (const agent of agents) {
      const base = agent.locationId === null ? undefined : ctx.positions.get(agent.locationId);
      let target: THREE.Vector3;
      if (base === undefined) {
        target = new THREE.Vector3(0, 1.4, 0);
      } else {
        const slot = perLocation.get(agent.locationId as string) ?? 0;
        perLocation.set(agent.locationId as string, slot + 1);
        target = new THREE.Vector3(
          base.x + Math.cos(slot * 1.6) * 1.5,
          1.4,
          base.z + Math.sin(slot * 1.6) * 1.5,
        );
      }

      let mesh = ctx.agentMeshes.get(agent.id);
      if (mesh === undefined) {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.45, 20, 20),
          new THREE.MeshStandardMaterial({ color: 0x94a3b8 }),
        );
        mesh.position.copy(target);
        ctx.agentGroup.add(mesh);
        ctx.agentMeshes.set(agent.id, mesh);
      }
      mesh.userData.target = target;
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color.setHex(STATE_COLORS[agent.state] ?? 0x94a3b8);
    }
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
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <div className="rounded border border-gray-200 bg-white p-2 shadow-sm">
          {error !== null && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
          <div ref={mountRef} className="h-[420px] w-full overflow-hidden rounded bg-[#0b1020]" />
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {Object.entries(STATE_COLORS)
              .filter(([key]) => ["IDLE", "WORKING", "THINKING", "RESTING", "SLEEPING", "SOCIALIZING", "TRAVELING"].includes(key))
              .map(([key, color]) => (
                <span key={key} className="inline-flex items-center gap-1 text-gray-600">
                  <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: `#${color.toString(16).padStart(6, "0")}` }} />
                  {key}
                </span>
              ))}
          </div>
        </div>
      </div>

      <div className="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Simulation</h2>
        {state === null ? (
          <p className="text-sm text-gray-500">Waiting for a world…</p>
        ) : (
          <>
            <dl className="mb-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-gray-500">World</dt>
              <dd className="text-right font-medium">{state.world.name}</dd>
              <dt className="text-gray-500">Status</dt>
              <dd className="text-right font-medium">{state.world.status}</dd>
              <dt className="text-gray-500">Speed</dt>
              <dd className="text-right font-medium">{state.world.timeScale}x</dd>
              <dt className="text-gray-500">Phase</dt>
              <dd className="text-right font-medium">{state.phase}</dd>
              <dt className="text-gray-500">Simulated</dt>
              <dd className="text-right font-medium">{new Date(state.simulatedNow).toLocaleString()}</dd>
              <dt className="text-gray-500">Heartbeat</dt>
              <dd className="text-right font-medium">{state.engine.heartbeatRunning ? "running" : "stopped"}</dd>
            </dl>
            <div className="mb-2 flex flex-wrap gap-2 text-xs text-gray-600">
              <span className="rounded bg-gray-100 px-2 py-0.5">Agents {state.counts.agents}</span>
              <span className="rounded bg-gray-100 px-2 py-0.5">Active {state.counts.activeActivities}</span>
              <span className="rounded bg-gray-100 px-2 py-0.5">Critical needs {state.counts.criticalNeeds}</span>
            </div>
            <ul className="divide-y">
              {state.agents.map((agent) => (
                <li key={agent.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{agent.name}</span>
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{agent.state}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {agent.title}
                    {agent.activity !== null ? ` · ${agent.activity.type} (${agent.activity.status})` : ""}
                  </div>
                  <div className="mt-1 flex gap-3 text-xs text-gray-500">
                    <span>Energy {Math.round(agent.needs.ENERGY ?? 0)}</span>
                    <span>Social {Math.round(agent.needs.SOCIAL ?? 0)}</span>
                    {agent.critical.length > 0 && <span className="text-red-600">Critical: {agent.critical.join(", ")}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
