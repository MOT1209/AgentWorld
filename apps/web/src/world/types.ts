/**
 * Types shared by the world view: the API DTOs it consumes and the pure
 * layout plan it renders. No three.js and no DOM here — this module is
 * imported by the Node-side test suite, which has neither.
 */

/* ------------------------------------------------------------------ API DTO */

export interface SimulationAgentSummaryDto {
  id: string;
  name: string;
  roleKey: string;
  title: string;
  state: string;
  locationId: string | null;
  activity: {
    id: string;
    type: string;
    status: string;
    startTime: string;
    expectedEndTime: string | null;
  } | null;
  needs: Record<string, number>;
  critical: string[];
}

export interface SimulationStateDto {
  world: {
    id: string;
    name: string;
    status: string;
    timeScale: number;
    timeOffsetMinutes: number;
    lastTickAt: string | null;
  };
  simulatedNow: string;
  wallNow: string;
  phase: string;
  engine: { heartbeatRunning: boolean; busy: boolean; tickIntervalMs: number };
  counts: { agents: number; activeActivities: number; criticalNeeds: number };
  agents: SimulationAgentSummaryDto[];
}

export interface LocationDto {
  id: string;
  name: string;
  kind: string;
  cityId: string;
  cityName: string;
  districtId: string | null;
  capacity: number | null;
  occupantCount: number;
  /** Optional: present on newer snapshots, absent on older ones. */
  address?: string | null;
  /** Optional JSON blob — `geometry`/`floorplan`/`x`/`z` overrides live here. */
  metadata?: unknown;
}

export interface DistrictDto {
  id: string;
  cityId: string;
  cityName: string;
  name: string;
  kind: string;
  description: string | null;
  geometry: unknown | null;
  locationCount: number;
}

export interface CityDto {
  id: string;
  name: string;
  kind: string;
  population: number;
  locationCount: number;
}

export interface WorldSnapshotDto {
  world: { id: string; name: string };
  simulatedNow: string;
  wallNow: string;
  phase: string;
  cities: CityDto[];
  districts: DistrictDto[];
  locations: LocationDto[];
  agentCount: number;
}

/** `GET /agents` row (the fields the inspector needs). */
export interface AgentDirectoryDto {
  id: string;
  name: string;
  roleKey: string;
  title: string;
  currentLocationId: string | null;
  currentCompanyId: string | null;
  currentJob: string | null;
}

/** `GET /companies` row. */
export interface CompanyDirectoryDto {
  id: string;
  name: string;
}

/* ------------------------------------------------------------- layout plan */

export type DistrictClass =
  | "CITY_CENTRE"
  | "RESIDENTIAL"
  | "COMMERCIAL"
  | "VILLAGE"
  | "PUBLIC"
  | "INDUSTRIAL"
  | "GENERIC";

export type BuildingArchetype =
  | "HOUSE"
  | "TOWNHOUSE"
  | "APARTMENT"
  | "SHOP"
  | "RESTAURANT"
  | "MARKET"
  | "OFFICE"
  | "HQ"
  | "BANK"
  | "CIVIC"
  | "SCHOOL"
  | "HOSPITAL"
  | "PARK_PAVILION"
  | "STATION"
  | "WAREHOUSE"
  | "GARAGE"
  | "BARN"
  | "CONTEXT_HOUSE"
  | "CONTEXT_BLOCK"
  | "CONTEXT_BARN";

export type RoadSurface = "ASPHALT" | "GRAVEL" | "PAVING" | "PATH";

export interface RoadSegment {
  id: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** Full width in world units. */
  width: number;
  surface: RoadSurface;
  sidewalk: boolean;
}

export type PatchKind = "PLAZA" | "LAWN" | "POND" | "FIELD" | "LOT" | "PATH";

export interface GroundPatch {
  id: string;
  x: number;
  z: number;
  w: number;
  h: number;
  kind: PatchKind;
}

export interface Parcel {
  x: number;
  z: number;
  w: number;
  h: number;
}

export interface BuildingPlan {
  /** Stable identity: the location id, or `ctx:<lotId>` for filler. */
  key: string;
  /** `null` for decorative context buildings (never DB-backed). */
  locationId: string | null;
  name: string;
  /** Raw location kind as stored in the DB (`HOUSE`, `HQ`, …). */
  kind: string;
  archetype: BuildingArchetype;
  districtId: string | null;
  districtName: string | null;
  cityName: string | null;
  address: string | null;
  x: number;
  z: number;
  /** Y-axis rotation in radians. The archetype front faces +Z. */
  rotation: number;
  footprint: { w: number; d: number; h: number };
  /** Deterministic palette/variant index derived from the plan key. */
  tone: number;
  occupants: { count: number; capacity: number | null };
  /** Decorative filler — muted, no DB record, not raycast-pickable. */
  context: boolean;
  selectable: boolean;
}

export interface DistrictPlan {
  id: string;
  name: string;
  cityName: string;
  kind: string;
  classification: DistrictClass;
  parcel: Parcel;
  roads: RoadSegment[];
  patches: GroundPatch[];
}

export type DecorKind = "TREE" | "BUSH" | "BENCH" | "LAMP" | "SIGN" | "FOUNTAIN";

export interface DecorPlan {
  key: string;
  kind: DecorKind;
  x: number;
  z: number;
  rotation: number;
  scale: number;
  tone: number;
}

export interface WorldLayoutPlan {
  groundSize: number;
  arterials: RoadSegment[];
  districts: DistrictPlan[];
  buildings: BuildingPlan[];
  decor: DecorPlan[];
}

export interface LayoutInput {
  districts: DistrictDto[];
  locations: LocationDto[];
  cities?: CityDto[];
  /** Fill remaining lots with muted non-DB buildings (default true). */
  includeContext?: boolean;
}
