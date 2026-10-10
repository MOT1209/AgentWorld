/**
 * Deterministic city layout for the Three.js world view.
 *
 * Pure data: no three.js, no DOM, no randomness that is not derived from a
 * plan key. The same snapshot always produces the same plan, and a sticky
 * `WorldLayoutEngine` keeps existing locations on their existing lots when
 * the snapshot refreshes (new locations fill the nearest free lot, removed
 * ones free theirs again).
 *
 * Spatial data resolution (backward compatible, no schema change):
 *   1. `location.metadata.x/z/rotation` when present and numeric — an
 *      operator pinning wins over everything.
 *   2. otherwise a lot generated along the street frontage of the
 *      location's district.
 * Districts may pin their parcel with `district.geometry` (`center` +
 * `bounds`); otherwise the class decides it (see FIXED_PARCELS).
 */
import type {
  BuildingArchetype,
  BuildingPlan,
  DecorPlan,
  DistrictClass,
  DistrictDto,
  DistrictPlan,
  GroundPatch,
  LayoutInput,
  LocationDto,
  Parcel,
  RoadSegment,
  RoadSurface,
  WorldLayoutPlan,
} from "./types.js";

export const GROUND_SIZE = 480;

/** Prime parcels, one per district class. GENERIC parks itself on the ring. */
const FIXED_PARCELS: Record<string, Parcel> = {
  CITY_CENTRE: { x: 0, z: 0, w: 112, h: 112 },
  RESIDENTIAL: { x: -96, z: 0, w: 80, h: 80 },
  COMMERCIAL: { x: 96, z: 0, w: 80, h: 80 },
  PUBLIC: { x: 0, z: -96, w: 72, h: 72 },
  VILLAGE: { x: 0, z: 108, w: 72, h: 72 },
  INDUSTRIAL: { x: 96, z: -96, w: 64, h: 64 },
};

/** Fallback parcels for GENERIC districts and extra districts of a class. */
const RING_SLOTS: readonly Parcel[] = [
  { x: 96, z: 96, w: 56, h: 56 },
  { x: -96, z: 96, w: 56, h: 56 },
  { x: -96, z: -96, w: 56, h: 56 },
  { x: 170, z: 0, w: 56, h: 56 },
  { x: -170, z: 0, w: 56, h: 56 },
  { x: 0, z: 190, w: 56, h: 56 },
  { x: 0, z: -190, w: 56, h: 56 },
  { x: 170, z: 170, w: 56, h: 56 },
  { x: -170, z: 170, w: 56, h: 56 },
  { x: 170, z: -170, w: 56, h: 56 },
  { x: -170, z: -170, w: 56, h: 56 },
];

/** Locations whose district is unknown land here (still inside the world). */
const ORPHAN_PARCEL: Parcel = { x: -170, z: 100, w: 56, h: 56 };

const SIDEWALK = 2.5;
const SETBACK = 1.5;

/* ------------------------------------------------------------------ helpers */

/** FNV-1a — stable across runs and platforms (no `hashCode` here). */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeKind(kind: string | null | undefined): string {
  return (kind ?? "").trim().toUpperCase();
}

const NAME_HINTS: ReadonlyArray<readonly [DistrictClass, readonly string[]]> = [
  ["CITY_CENTRE", ["CENTRE", "CENTER", "DOWNTOWN", "ALTSTADT", "CBD"]],
  ["RESIDENTIAL", ["RESID", "HOUSING", "WOHN", "SUBURB", "NEIGHBOR", "NEIGHBOUR"]],
  ["COMMERCIAL", ["BUSINESS", "COMMER", "SHOPPING", "GEWERBE", "MARKET"]],
  ["VILLAGE", ["VILLAGE", "DORF", "RURAL", "FARM", "HAMLET"]],
  ["PUBLIC", ["PARK", "PUBLIC", "GREEN", "RECREAT", "PLAZA", "PLATZ", "GARDEN"]],
  ["INDUSTRIAL", ["INDUST", "FACTORY", "WERK", "LOGISTIC", "PORT", "HARBOR", "HARBOUR"]],
];

/** District kind/name → world-zone class. Deterministic and total. */
export function classifyDistrict(kind: string | null | undefined, name: string | null | undefined): DistrictClass {
  const k = normalizeKind(kind);
  if (k === "CITY_CENTRE" || k === "CITY_CENTER" || k === "DOWNTOWN" || k === "CBD") return "CITY_CENTRE";
  if (k === "RESIDENTIAL" || k === "HOUSING") return "RESIDENTIAL";
  if (k === "BUSINESS" || k === "COMMERCIAL" || k === "COMMERCE" || k === "INDUSTRIAL") {
    return k === "INDUSTRIAL" ? "INDUSTRIAL" : "COMMERCIAL";
  }
  if (k === "VILLAGE" || k === "RURAL") return "VILLAGE";
  if (k === "PUBLIC" || k === "PUBLIC_SPACE" || k === "PARK" || k === "GREEN") return "PUBLIC";

  const haystack = `${normalizeKind(name)} ${(name ?? "").toUpperCase()}`.toUpperCase();
  for (const [cls, hints] of NAME_HINTS) {
    for (const hint of hints) {
      if (haystack.includes(hint.toUpperCase())) return cls;
    }
  }
  return "GENERIC";
}

const CONTEXT_ARCHETYPES: Record<DistrictClass, BuildingArchetype> = {
  CITY_CENTRE: "CONTEXT_BLOCK",
  RESIDENTIAL: "CONTEXT_HOUSE",
  COMMERCIAL: "CONTEXT_BLOCK",
  VILLAGE: "CONTEXT_BARN",
  PUBLIC: "CONTEXT_HOUSE",
  INDUSTRIAL: "CONTEXT_BLOCK",
  GENERIC: "CONTEXT_BLOCK",
};

/** Location kind (+ district class for unknowns) → building archetype. */
export function archetypeFor(kind: string | null | undefined, cls: DistrictClass, seed: number): BuildingArchetype {
  const k = normalizeKind(kind);
  switch (k) {
    case "HOUSE":
    case "HOME":
      return cls === "VILLAGE" ? "BARN" : seed % 3 === 0 ? "TOWNHOUSE" : "HOUSE";
    case "APARTMENT":
    case "FLAT":
      return "APARTMENT";
    case "SHOP":
    case "STORE":
      return "SHOP";
    case "RESTAURANT":
    case "CAFE":
    case "BAR":
      return "RESTAURANT";
    case "MARKET":
      return "MARKET";
    case "OFFICE":
      return "OFFICE";
    case "HQ":
    case "COMPANY":
      return "HQ";
    case "BANK":
      return "BANK";
    case "GOVERNMENT":
    case "CIVIC":
    case "TOWN_HALL":
    case "CHURCH":
    case "ADMIN":
      return "CIVIC";
    case "SCHOOL":
    case "UNIVERSITY":
    case "ACADEMY":
      return "SCHOOL";
    case "HOSPITAL":
    case "CLINIC":
      return "HOSPITAL";
    case "PUBLIC_SPACE":
    case "PARK":
    case "PLAZA":
    case "PLATZ":
    case "COMMON_AREA":
      return "PARK_PAVILION";
    case "TRANSPORT":
    case "STATION":
    case "BUS_STOP":
    case "DEPOT":
      return "STATION";
    case "WAREHOUSE":
    case "FACTORY":
      return "WAREHOUSE";
    case "GARAGE":
      return "GARAGE";
    case "FARM":
    case "FARMHOUSE":
    case "BARN":
      return "BARN";
    default:
      return CONTEXT_ARCHETYPES[cls];
  }
}

export interface Footprint {
  w: number;
  d: number;
  h: number;
}

/** Real-world-ish sizes so the city reads at a glance. */
const FOOTPRINTS: Record<BuildingArchetype, Footprint> = {
  HOUSE: { w: 9, d: 10, h: 3.6 },
  TOWNHOUSE: { w: 8, d: 11, h: 7.2 },
  APARTMENT: { w: 13, d: 11, h: 12.5 },
  SHOP: { w: 12, d: 10, h: 4.6 },
  RESTAURANT: { w: 12, d: 10, h: 4.6 },
  MARKET: { w: 16, d: 12, h: 6.2 },
  OFFICE: { w: 15, d: 12, h: 15.5 },
  HQ: { w: 20, d: 14, h: 24 },
  BANK: { w: 14, d: 12, h: 9.4 },
  CIVIC: { w: 18, d: 13, h: 10.6 },
  SCHOOL: { w: 20, d: 12, h: 8.2 },
  HOSPITAL: { w: 18, d: 14, h: 14.4 },
  PARK_PAVILION: { w: 10, d: 10, h: 4.2 },
  STATION: { w: 16, d: 10, h: 6.4 },
  WAREHOUSE: { w: 20, d: 16, h: 8.4 },
  GARAGE: { w: 12, d: 10, h: 5 },
  BARN: { w: 12, d: 10, h: 5.2 },
  CONTEXT_HOUSE: { w: 8, d: 9, h: 3.4 },
  CONTEXT_BLOCK: { w: 13, d: 11, h: 10.5 },
  CONTEXT_BARN: { w: 11, d: 9, h: 4.6 },
};

export function footprintFor(archetype: BuildingArchetype): Footprint {
  return FOOTPRINTS[archetype];
}

interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
  rotation: number;
}

function axisFor(rect: Rect): { ax: [number, number]; az: [number, number] } {
  const cos = Math.cos(rect.rotation);
  const sin = Math.sin(rect.rotation);
  return { ax: [cos, -sin], az: [sin, cos] };
}

function project(rect: Rect, axis: readonly [number, number]): { min: number; max: number } {
  const { ax, az } = axisFor(rect);
  const half =
    Math.abs(ax[0] * axis[0] + ax[1] * axis[1]) * (rect.w / 2) +
    Math.abs(az[0] * axis[0] + az[1] * axis[1]) * (rect.d / 2);
  const center = rect.x * axis[0] + rect.z * axis[1];
  return { min: center - half, max: center + half };
}

/** Separating-axis overlap for two rotated rectangles (strict: touching is free). */
export function rotatedRectsOverlap(a: Rect, b: Rect): boolean {
  const axes: Array<readonly [number, number]> = [];
  for (const rect of [a, b]) {
    const { ax, az } = axisFor(rect);
    axes.push(ax, az);
  }
  for (const axis of axes) {
    const pa = project(a, axis);
    const pb = project(b, axis);
    // Separated on this axis → no overlap; only overlap if all axes overlap.
    if (pa.max <= pb.min || pb.max <= pa.min) return false;
  }
  return true;
}

function roadRect(seg: RoadSegment): Rect {
  return {
    x: (seg.x1 + seg.x2) / 2,
    z: (seg.z1 + seg.z2) / 2,
    w: Math.abs(seg.x2 - seg.x1) + seg.width,
    d: Math.abs(seg.z2 - seg.z1) + seg.width,
    rotation: 0,
  };
}

function insideParcel(x: number, z: number, parcel: Parcel, margin: number): boolean {
  return (
    x >= parcel.x - parcel.w / 2 + margin &&
    x <= parcel.x + parcel.w / 2 - margin &&
    z >= parcel.z - parcel.h / 2 + margin &&
    z <= parcel.z + parcel.h / 2 - margin
  );
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `metadata.x/z/rotation` (or `metadata.geometry.center`) as an operator pin. */
function readMetadataPlacement(metadata: unknown): { x: number; z: number; rotation: number } | null {
  let value = metadata;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const geometry =
    typeof record.geometry === "object" && record.geometry !== null ? (record.geometry as Record<string, unknown>) : null;
  const center = geometry !== null && typeof geometry.center === "object" && geometry.center !== null
    ? (geometry.center as Record<string, unknown>)
    : null;
  const x = readNumber(record.x) ?? readNumber(center?.x);
  const z = readNumber(record.z) ?? readNumber(center?.z) ?? readNumber(center?.y);
  if (x === null || z === null) return null;
  return { x, z, rotation: readNumber(record.rotation) ?? 0 };
}

/** `district.geometry` (`{center:{x,y}, bounds:[x,y,w,h]}`) as a pinned parcel. */
export function readDistrictParcel(geometry: unknown): Parcel | null {
  if (typeof geometry !== "object" || geometry === null) return null;
  const record = geometry as Record<string, unknown>;
  const center = typeof record.center === "object" && record.center !== null
    ? (record.center as Record<string, unknown>)
    : null;
  const bounds = Array.isArray(record.bounds) ? record.bounds : null;
  const cx = center === null ? null : readNumber(center.x);
  const cz = center === null ? null : (readNumber(center.z) ?? readNumber(center.y));
  const bx = bounds === null ? null : readNumber(bounds[0]);
  const bz = bounds === null ? null : readNumber(bounds[1]);
  const bw = bounds === null ? null : readNumber(bounds[2]);
  const bh = bounds === null ? null : readNumber(bounds[3]);
  const x = cx ?? bx;
  const z = cz ?? bz;
  if (x === null || z === null) return null;
  if (bw === null || bh === null || bw <= 0 || bh <= 0) return null;
  return { x, z, w: bw, h: bh };
}

/* ------------------------------------------------------------- road helpers */

function road(
  id: string,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  width: number,
  surface: RoadSurface,
  sidewalk: boolean,
): RoadSegment {
  return { id, x1, z1, x2, z2, width, surface, sidewalk };
}

function patch(id: string, x: number, z: number, w: number, h: number, kind: GroundPatch["kind"]): GroundPatch {
  return { id, x, z, w, h, kind };
}

interface LotCandidate {
  id: string;
  x: number;
  z: number;
  rotation: number;
  /** Assumed building size used for setback maths; the real one may be smaller. */
  w: number;
  d: number;
}

/**
 * Walk a road frontage and emit lots on both sides. Centerlines are in world
 * space, so lots are already rotated to face their street. IDs embed the
 * rounded position so they stay unique across roads (an index would collide
 * between frontages).
 */
function lotsAlongRoad(
  districtId: string,
  seg: RoadSegment,
  opts: { spacing: number; depth: number; margin: number; sides?: readonly (1 | -1)[] },
): LotCandidate[] {
  const dx = seg.x2 - seg.x1;
  const dz = seg.z2 - seg.z1;
  const length = Math.hypot(dx, dz);
  if (length < 1) return [];
  const ux = dx / length;
  const uz = dz / length;
  const nx = -uz;
  const nz = ux;
  const offset = seg.width / 2 + (seg.sidewalk ? SIDEWALK : 0) + SETBACK + opts.depth / 2;
  const sides = opts.sides ?? [1, -1];
  const out: LotCandidate[] = [];
  for (const side of sides) {
    for (let t = opts.margin; t <= length - opts.margin + 1e-6; t += opts.spacing) {
      const cx = Math.round((seg.x1 + ux * t + nx * side * offset) * 100) / 100;
      const cz = Math.round((seg.z1 + uz * t + nz * side * offset) * 100) / 100;
      const dirX = -nx * side;
      const dirZ = -nz * side;
      out.push({
        id: `${districtId}:lot:${cx}:${cz}`,
        x: cx,
        z: cz,
        rotation: Math.atan2(dirX, dirZ),
        w: opts.depth,
        d: opts.depth,
      });
    }
  }
  return out;
}

function fixedLot(
  districtId: string,
  index: number,
  x: number,
  z: number,
  rotation: number,
  size: number,
): LotCandidate {
  return { id: `${districtId}:lot:${index}`, x, z, rotation, w: size, d: size };
}

/* ------------------------------------------------------ district generators */

interface DistrictGeometryPlan {
  roads: RoadSegment[];
  patches: GroundPatch[];
  lots: LotCandidate[];
  allowContext: boolean;
}

function districtGeometry(districtId: string, cls: DistrictClass, parcel: Parcel): DistrictGeometryPlan {
  const plan = (() => {
    switch (cls) {
      case "CITY_CENTRE":
        return centreGeometry(districtId, parcel);
      case "RESIDENTIAL":
        return residentialGeometry(districtId, parcel);
      case "COMMERCIAL":
        return commercialGeometry(districtId, parcel);
      case "VILLAGE":
        return villageGeometry(districtId, parcel);
      case "PUBLIC":
        return publicGeometry(districtId, parcel);
      case "INDUSTRIAL":
        return industrialGeometry(districtId, parcel);
      default:
        return genericGeometry(districtId, parcel);
    }
  })();
  // Lots whose footprint would leave the parcel (outer side of edge roads)
  // are dropped; real locations then take the next free inner lot.
  const kept = plan.lots.filter((lot) => insideParcel(lot.x, lot.z, parcel, lot.w / 2 + 0.5));
  return { ...plan, lots: kept };
}

/**
 * The shared north-south/east-west arterials pass straight through several
 * fixed parcels. Clip a frontage segment to the parcel so buildings can face
 * the main avenue without sitting on the road itself.
 */
function arterialFrontage(districtId: string, seg: RoadSegment, parcel: Parcel): RoadSegment | null {
  const horizontal = Math.abs(seg.z2 - seg.z1) < 1e-6;
  const roadHalf = seg.width / 2 + 3;
  if (horizontal) {
    if (Math.abs(seg.z1 - parcel.z) > parcel.h / 2) return null;
    const x1 = Math.max(Math.min(seg.x1, seg.x2), parcel.x - parcel.w / 2 + roadHalf);
    const x2 = Math.min(Math.max(seg.x1, seg.x2), parcel.x + parcel.w / 2 - roadHalf);
    if (x2 - x1 < 12) return null;
    return road(`${districtId}:frontage`, x1, seg.z1, x2, seg.z2, seg.width, seg.surface, seg.sidewalk);
  }
  if (Math.abs(seg.x1 - parcel.x) > parcel.w / 2) return null;
  const z1 = Math.max(Math.min(seg.z1, seg.z2), parcel.z - parcel.h / 2 + roadHalf);
  const z2 = Math.min(Math.max(seg.z1, seg.z2), parcel.z + parcel.h / 2 - roadHalf);
  if (z2 - z1 < 12) return null;
  return road(`${districtId}:frontage`, seg.x1, z1, seg.x2, z2, seg.width, seg.surface, seg.sidewalk);
}

function centreGeometry(districtId: string, parcel: Parcel): DistrictGeometryPlan {
  const roads = [
    road(`${districtId}:ring:n`, parcel.x - 28, parcel.z - 28, parcel.x + 28, parcel.z - 28, 6, "ASPHALT", true),
    road(`${districtId}:ring:s`, parcel.x - 28, parcel.z + 28, parcel.x + 28, parcel.z + 28, 6, "ASPHALT", true),
    road(`${districtId}:ring:w`, parcel.x - 28, parcel.z - 28, parcel.x - 28, parcel.z + 28, 6, "ASPHALT", true),
    road(`${districtId}:ring:e`, parcel.x + 28, parcel.z - 28, parcel.x + 28, parcel.z + 28, 6, "ASPHALT", true),
  ];
  const patches = [patch(`${districtId}:plaza`, parcel.x, parcel.z, 34, 34, "PLAZA")];
  const lots: LotCandidate[] = [];
  for (const [index, seg] of roads.entries()) {
    // The n/s ring segments straddle the north-south arterial and the e/w
    // segments the east-west arterial; keep lots off both avenues.
    const horizontal = index < 2;
    const generated = lotsAlongRoad(districtId, seg, { spacing: 14, depth: 14, margin: 3 });
    for (const lot of generated) {
      if (horizontal && Math.abs(lot.x - parcel.x) < 12) continue;
      if (!horizontal && Math.abs(lot.z - parcel.z) < 12) continue;
      lots.push(lot);
    }
  }
  return { roads, patches, lots, allowContext: true };
}

function residentialGeometry(districtId: string, parcel: Parcel): DistrictGeometryPlan {
  const roads = [
    road(`${districtId}:ns:a`, parcel.x - 24, parcel.z - 36, parcel.x - 24, parcel.z + 36, 6, "ASPHALT", true),
    road(`${districtId}:ns:b`, parcel.x, parcel.z - 36, parcel.x, parcel.z + 36, 6, "ASPHALT", true),
    road(`${districtId}:ns:c`, parcel.x + 24, parcel.z - 36, parcel.x + 24, parcel.z + 36, 6, "ASPHALT", true),
    road(`${districtId}:ew:a`, parcel.x - 36, parcel.z - 28, parcel.x + 36, parcel.z - 28, 5, "ASPHALT", true),
    road(`${districtId}:ew:b`, parcel.x - 36, parcel.z + 28, parcel.x + 36, parcel.z + 28, 5, "ASPHALT", true),
  ];
  const patches = [
    patch(`${districtId}:lawn:sw`, parcel.x - 12, parcel.z - 14, 18, 18, "LAWN"),
    patch(`${districtId}:lawn:se`, parcel.x + 12, parcel.z - 14, 18, 18, "LAWN"),
    patch(`${districtId}:lawn:nw`, parcel.x - 12, parcel.z + 14, 18, 18, "LAWN"),
    patch(`${districtId}:lawn:ne`, parcel.x + 12, parcel.z + 14, 18, 18, "LAWN"),
  ];
  const lots: LotCandidate[] = [];
  for (const seg of roads) {
    lots.push(...lotsAlongRoad(districtId, seg, { spacing: 15, depth: 14, margin: 4 }));
  }
  for (const arterial of buildArterials()) {
    const frontage = arterialFrontage(districtId, arterial, parcel);
    if (frontage !== null) {
      roads.push(frontage);
      lots.push(...lotsAlongRoad(districtId, frontage, { spacing: 16, depth: 14, margin: 4 }));
    }
  }
  return { roads, patches, lots, allowContext: true };
}

function commercialGeometry(districtId: string, parcel: Parcel): DistrictGeometryPlan {
  const roads = [
    road(`${districtId}:ns`, parcel.x, parcel.z - 36, parcel.x, parcel.z + 36, 8, "ASPHALT", true),
    road(`${districtId}:ew:n`, parcel.x - 36, parcel.z - 26, parcel.x + 36, parcel.z - 26, 6, "ASPHALT", true),
    road(`${districtId}:ew:s`, parcel.x - 36, parcel.z + 26, parcel.x + 36, parcel.z + 26, 6, "ASPHALT", true),
  ];
  const patches = [
    patch(`${districtId}:plaza`, parcel.x + 16, parcel.z, 16, 16, "PLAZA"),
    patch(`${districtId}:lot`, parcel.x - 16, parcel.z, 22, 22, "LOT"),
  ];
  const lots: LotCandidate[] = [];
  for (const seg of roads) {
    lots.push(...lotsAlongRoad(districtId, seg, { spacing: 17, depth: 14, margin: 4 }));
  }
  for (const arterial of buildArterials()) {
    const frontage = arterialFrontage(districtId, arterial, parcel);
    if (frontage !== null) {
      roads.push(frontage);
      lots.push(...lotsAlongRoad(districtId, frontage, { spacing: 17, depth: 14, margin: 4 }));
    }
  }
  return { roads, patches, lots, allowContext: true };
}

function villageGeometry(districtId: string, parcel: Parcel): DistrictGeometryPlan {
  const roads = [
    road(`${districtId}:lane:n`, parcel.x - 32, parcel.z - 14, parcel.x + 32, parcel.z - 14, 5, "GRAVEL", false),
    road(`${districtId}:lane:s`, parcel.x - 32, parcel.z + 14, parcel.x + 32, parcel.z + 14, 5, "GRAVEL", false),
    road(`${districtId}:lane:w`, parcel.x - 20, parcel.z - 32, parcel.x - 20, parcel.z + 32, 4, "GRAVEL", false),
  ];
  const patches = [
    patch(`${districtId}:green`, parcel.x, parcel.z, 14, 14, "LAWN"),
    patch(`${districtId}:field:e`, parcel.x + 24, parcel.z - 24, 16, 14, "FIELD"),
    patch(`${districtId}:field:s`, parcel.x + 24, parcel.z + 24, 16, 14, "FIELD"),
    patch(`${districtId}:field:w`, parcel.x - 28, parcel.z + 4, 10, 18, "FIELD"),
  ];
  const lots: LotCandidate[] = [];
  for (const seg of roads) {
    lots.push(...lotsAlongRoad(districtId, seg, { spacing: 16, depth: 12, margin: 4 }));
  }
  for (const arterial of buildArterials()) {
    const frontage = arterialFrontage(districtId, arterial, parcel);
    if (frontage !== null) {
      roads.push(frontage);
      lots.push(...lotsAlongRoad(districtId, frontage, { spacing: 16, depth: 12, margin: 4 }));
    }
  }
  return { roads, patches, lots, allowContext: true };
}

function publicGeometry(districtId: string, parcel: Parcel): DistrictGeometryPlan {
  const roads = [
    road(`${districtId}:loop:n`, parcel.x - 18, parcel.z - 18, parcel.x + 18, parcel.z - 18, 2.5, "PATH", false),
    road(`${districtId}:loop:s`, parcel.x - 18, parcel.z + 18, parcel.x + 18, parcel.z + 18, 2.5, "PATH", false),
    road(`${districtId}:loop:w`, parcel.x - 18, parcel.z - 18, parcel.x - 18, parcel.z + 18, 2.5, "PATH", false),
    road(`${districtId}:loop:e`, parcel.x + 18, parcel.z - 18, parcel.x + 18, parcel.z + 18, 2.5, "PATH", false),
    road(`${districtId}:spur`, parcel.x + 12, parcel.z - 30, parcel.x + 12, parcel.z + 30, 2.5, "PATH", false),
  ];
  const patches = [
    patch(`${districtId}:lawn:w`, parcel.x - 16, parcel.z, 24, 30, "LAWN"),
    patch(`${districtId}:lawn:e`, parcel.x + 16, parcel.z, 24, 30, "LAWN"),
    // Pond stays inside the west lawn, clear of the loop path and the
    // north-south arterial that runs through the park's centre.
    patch(`${districtId}:pond`, parcel.x - 11, parcel.z - 9, 8, 8, "POND"),
    patch(`${districtId}:plaza`, parcel.x + 16, parcel.z + 10, 14, 14, "PLAZA"),
  ];
  // Pavilions sit outside the loop, facing inward. The old fifth lot at
  // (px+8, pz+26) straddled the arterial — dropped.
  const lots: LotCandidate[] = [
    fixedLot(districtId, 0, parcel.x + 28, parcel.z - 8, -Math.PI / 2, 14),
    fixedLot(districtId, 1, parcel.x + 28, parcel.z + 8, -Math.PI / 2, 14),
    fixedLot(districtId, 2, parcel.x - 28, parcel.z - 8, Math.PI / 2, 14),
    fixedLot(districtId, 3, parcel.x - 28, parcel.z + 8, Math.PI / 2, 14),
  ];
  return { roads, patches, lots, allowContext: false };
}

function industrialGeometry(districtId: string, parcel: Parcel): DistrictGeometryPlan {
  const roads = [
    road(`${districtId}:ns`, parcel.x, parcel.z - parcel.h / 2 + 4, parcel.x, parcel.z + parcel.h / 2 - 4, 7, "ASPHALT", false),
    road(`${districtId}:ew`, parcel.x - parcel.w / 2 + 4, parcel.z, parcel.x + parcel.w / 2 - 4, parcel.z, 7, "ASPHALT", false),
  ];
  const patches = [patch(`${districtId}:yard`, parcel.x, parcel.z, parcel.w - 16, parcel.h - 16, "LOT")];
  const lots: LotCandidate[] = [];
  for (const seg of roads) {
    lots.push(...lotsAlongRoad(districtId, seg, { spacing: 24, depth: 18, margin: 6 }));
  }
  return { roads, patches, lots, allowContext: true };
}

function genericGeometry(districtId: string, parcel: Parcel): DistrictGeometryPlan {
  const roads = [
    road(`${districtId}:ns`, parcel.x, parcel.z - parcel.h / 2 + 4, parcel.x, parcel.z + parcel.h / 2 - 4, 6, "ASPHALT", false),
    road(`${districtId}:ew`, parcel.x - parcel.w / 2 + 4, parcel.z, parcel.x + parcel.w / 2 - 4, parcel.z, 6, "ASPHALT", false),
  ];
  const patches = [patch(`${districtId}:yard`, parcel.x, parcel.z, parcel.w - 18, parcel.h - 18, "LOT")];
  const lots: LotCandidate[] = [];
  for (const seg of roads) {
    lots.push(...lotsAlongRoad(districtId, seg, { spacing: 22, depth: 16, margin: 5 }));
  }
  return { roads, patches, lots, allowContext: true };
}

/** World-connecting roads. Shared by every district, generated once. */
function buildArterials(): RoadSegment[] {
  return [
    road("arterial:ew", -220, 0, 220, 0, 10, "ASPHALT", true),
    road("arterial:ns-city", 0, -220, 0, 60, 10, "ASPHALT", true),
    road("arterial:ns-rural", 0, 60, 0, 200, 8, "GRAVEL", false),
  ];
}

/* ------------------------------------------------------------------ engine */

interface DistrictSeed {
  id: string;
  name: string;
  cityName: string;
  kind: string;
  classification: DistrictClass;
  parcel: Parcel;
}

interface PlacedBuilding extends Rect {
  key: string;
  districtId: string;
}

/**
 * Sticky layout: district parcels, lot assignments and overflow counters
 * survive `update()` calls, so a refresh moves nothing that already existed.
 * `reset()` forgets everything (a fresh world).
 */
export class WorldLayoutEngine {
  private readonly parcels = new Map<string, DistrictSeed>();
  private readonly cityOffsets = new Map<string, { x: number; z: number }>();
  private readonly geometryCache = new Map<string, DistrictGeometryPlan>();
  private readonly lotAssignments = new Map<string, string>();
  private readonly usedLots = new Set<string>();
  private readonly overflowCounters = new Map<string, number>();
  /** Memoized fallback spots so orphans/spills stay put across refreshes. */
  private readonly inlinePlacements = new Map<string, { x: number; z: number; rotation: number }>();
  private readonly spillPlacements = new Map<string, { x: number; z: number }>();

  reset(): void {
    this.parcels.clear();
    this.cityOffsets.clear();
    this.geometryCache.clear();
    this.lotAssignments.clear();
    this.usedLots.clear();
    this.overflowCounters.clear();
    this.inlinePlacements.clear();
    this.spillPlacements.clear();
  }

  update(input: LayoutInput): WorldLayoutPlan {
    const includeContext = input.includeContext ?? true;
    const districts = dedupeById(input.districts).sort(byId);
    const locations = dedupeById(input.locations).sort(byId);
    const cityOffsets = this.resolveCityOffsets(districts);

    // Lots are re-claimed from scratch each pass: removed locations free
    // theirs, sticky ones re-claim in `pickLot`.
    this.usedLots.clear();

    const seeds: DistrictSeed[] = [];
    const takenParcels = new Set<string>();
    let ringCursor = 0;
    for (const district of districts) {
      const classification = classifyDistrict(district.kind, district.name);
      const offset = cityOffsets.get(district.cityId) ?? { x: 0, z: 0 };
      const pinned = readDistrictParcel(district.geometry);
      let parcel: Parcel;
      if (pinned !== null) {
        parcel = { x: pinned.x + offset.x, z: pinned.z + offset.z, w: pinned.w, h: pinned.h };
      } else {
        const existing = this.parcels.get(district.id);
        if (existing !== undefined && !takenParcels.has(parcelKey(existing.parcel))) {
          parcel = existing.parcel;
        } else {
          const fixed = FIXED_PARCELS[classification];
          if (fixed !== undefined && !takenParcels.has(parcelKey(applyOffset(fixed, offset)))) {
            parcel = applyOffset(fixed, offset);
          } else {
            let slot: Parcel | null = null;
            while (ringCursor < RING_SLOTS.length) {
              const candidate = RING_SLOTS[ringCursor];
              ringCursor += 1;
              if (candidate === undefined) break;
              const shifted = applyOffset(candidate, offset);
              if (!takenParcels.has(parcelKey(shifted))) {
                slot = shifted;
                break;
              }
            }
            parcel =
              slot ?? {
                x: offset.x + Math.cos(ringCursor * 1.7) * 240,
                z: offset.z + Math.sin(ringCursor * 1.7) * 240,
                w: 48,
                h: 48,
              };
          }
        }
        parcel = {
          x: Math.round(parcel.x * 100) / 100,
          z: Math.round(parcel.z * 100) / 100,
          w: parcel.w,
          h: parcel.h,
        };
      }
      takenParcels.add(parcelKey(parcel));
      const seed: DistrictSeed = {
        id: district.id,
        name: district.name,
        cityName: district.cityName,
        kind: district.kind,
        classification,
        parcel,
      };
      seeds.push(seed);
      this.parcels.set(district.id, seed);
    }

    const arterials = buildArterials();
    const placed: PlacedBuilding[] = [];
    const buildings: BuildingPlan[] = [];
    const geometryById = new Map<string, DistrictGeometryPlan>();

    for (const seed of seeds) {
      let geometry = this.geometryCache.get(seed.id);
      if (geometry === undefined) {
        geometry = districtGeometry(seed.id, seed.classification, seed.parcel);
        this.geometryCache.set(seed.id, geometry);
      }
      geometryById.set(seed.id, geometry);
    }

    // Placement checks must consider the shared arterials too, otherwise
    // buildings sit on the main avenues that cut through several parcels.
    const roadsByDistrict = (districtId: string): RoadSegment[] => {
      const geometry = geometryById.get(districtId);
      return [...arterials, ...(geometry === undefined ? [] : geometry.roads)];
    };

    // 1) Real locations, in id order, onto their sticky lots.
    for (const location of locations) {
      const seed =
        location.districtId === null ? undefined : seeds.find((candidate) => candidate.id === location.districtId);
      const districtId = seed?.id ?? "orphan";
      const parcel = seed?.parcel ?? ORPHAN_PARCEL;
      const classification = seed?.classification ?? "GENERIC";
      const placement = readMetadataPlacement(location.metadata);

      let x: number;
      let z: number;
      let rotation: number;
      if (placement !== null) {
        x = placement.x;
        z = placement.z;
        rotation = placement.rotation;
      } else {
        const lot = this.pickLot(location.id, districtId, geometryById.get(districtId), classification, parcel);
        x = lot.x;
        z = lot.z;
        rotation = lot.rotation;
      }

      const seedValue = hashString(location.id);
      const archetype = archetypeFor(location.kind, classification, seedValue);
      const footprint = footprintFor(archetype);
      const plan: BuildingPlan = {
        key: location.id,
        locationId: location.id,
        name: location.name,
        kind: normalizeKind(location.kind) || "OTHER",
        archetype,
        districtId: seed?.id ?? null,
        districtName: seed?.name ?? null,
        cityName: location.cityName,
        address: location.address ?? null,
        x,
        z,
        rotation,
        footprint,
        tone: seedValue % 6,
        occupants: { count: location.occupantCount, capacity: location.capacity },
        context: false,
        selectable: true,
      };
      const roads = roadsByDistrict(districtId);
      if (placement !== null) {
        // Operator pin: coordinates win. Record occupancy so later buildings
        // avoid it, but never spill the pin itself.
        this.tryPlace(placed, plan, roads);
      } else if (!this.tryPlace(placed, plan, roads)) {
        // Nothing free: spill onto a deterministic ring around the district.
        const spill = this.spillPosition(location.id, parcel, districtId, placed, roads);
        plan.x = spill.x;
        plan.z = spill.z;
        this.tryPlace(placed, plan, roads);
      }
      buildings.push(plan);
    }

    // 2) Decorative filler on the remaining lots (clearly not DB records).
    if (includeContext) {
      for (const seed of seeds) {
        const geometry = geometryById.get(seed.id);
        if (geometry === undefined || !geometry.allowContext) continue;
        for (const lot of geometry.lots) {
          if (this.usedLots.has(lot.id)) continue;
          const variant = hashString(lot.id);
          const archetype = contextArchetypeFor(seed.classification, variant);
          const footprint = footprintFor(archetype);
          const plan: BuildingPlan = {
            key: `ctx:${lot.id}`,
            locationId: null,
            name: "",
            kind: "CONTEXT",
            archetype,
            districtId: seed.id,
            districtName: seed.name,
            cityName: seed.cityName,
            address: null,
            x: lot.x,
            z: lot.z,
            rotation: lot.rotation,
            footprint,
            tone: variant % 4,
            occupants: { count: 0, capacity: null },
            context: true,
            selectable: false,
          };
          if (!this.tryPlace(placed, plan, roadsByDistrict(seed.id))) continue;
          buildings.push(plan);
        }
      }
    }

    const districtPlans: DistrictPlan[] = seeds.map((seed) => {
      const geometry = geometryById.get(seed.id);
      return {
        id: seed.id,
        name: seed.name,
        cityName: seed.cityName,
        kind: seed.kind,
        classification: seed.classification,
        parcel: seed.parcel,
        roads: geometry === undefined ? [] : geometry.roads,
        patches: geometry === undefined ? [] : geometry.patches,
      };
    });

    return {
      groundSize: GROUND_SIZE,
      arterials,
      districts: districtPlans,
      buildings,
      decor: this.buildDecor(districtPlans, placed, locations),
    };
  }

  /* --------------------------------------------------------- lot selection */

  private pickLot(
    locationId: string,
    districtId: string,
    geometry: DistrictGeometryPlan | undefined,
    classification: DistrictClass,
    parcel: Parcel,
  ): { x: number; z: number; rotation: number; lotId: string | null } {
    const stickyLotId = this.lotAssignments.get(locationId);
    if (stickyLotId !== undefined) {
      const sticky = geometry?.lots.find((lot) => lot.id === stickyLotId);
      if (sticky !== undefined && !this.usedLots.has(sticky.id)) {
        this.usedLots.add(sticky.id);
        return { x: sticky.x, z: sticky.z, rotation: sticky.rotation, lotId: sticky.id };
      }
    }
    const free = geometry?.lots.find((lot) => !this.usedLots.has(lot.id));
    if (free !== undefined) {
      this.lotAssignments.set(locationId, free.id);
      this.usedLots.add(free.id);
      return { x: free.x, z: free.z, rotation: free.rotation, lotId: free.id };
    }
    // No lots at all (tiny/pinned district): deterministic, memoized offset.
    const memo = this.inlinePlacements.get(locationId);
    if (memo !== undefined) return { ...memo, lotId: null };
    const counter = (this.overflowCounters.get(`${districtId}:inline`) ?? 0) + 1;
    this.overflowCounters.set(`${districtId}:inline`, counter);
    const angle = counter * 2.399963;
    const radius = Math.max(parcel.w, parcel.h) / 2 - 6;
    const placement = {
      x: Math.round((parcel.x + Math.cos(angle) * radius) * 100) / 100,
      z: Math.round((parcel.z + Math.sin(angle) * radius) * 100) / 100,
      rotation: classification === "GENERIC" ? 0 : angle,
    };
    this.inlinePlacements.set(locationId, placement);
    return { ...placement, lotId: null };
  }

  private spillPosition(
    locationId: string,
    parcel: Parcel,
    districtId: string,
    placed: PlacedBuilding[],
    roads: RoadSegment[],
  ): { x: number; z: number } {
    const memo = this.spillPlacements.get(locationId);
    if (memo !== undefined) return memo;
    const base = (this.overflowCounters.get(`${districtId}:spill`) ?? 0) + 1;
    const half = Math.max(parcel.w, parcel.h) / 2;
    let fallback = { x: parcel.x + half + 20, z: parcel.z };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const index = base + attempt;
      const angle = index * 2.399963;
      const ring = Math.floor(index / 8);
      const radius = half + 16 + ring * 20;
      const candidate = {
        x: Math.round((parcel.x + Math.cos(angle) * radius) * 100) / 100,
        z: Math.round((parcel.z + Math.sin(angle) * radius) * 100) / 100,
      };
      this.overflowCounters.set(`${districtId}:spill`, index);
      const probe: Rect = { x: candidate.x, z: candidate.z, w: 10, d: 10, rotation: 0 };
      const blocked =
        placed.some((other) => rotatedRectsOverlap(probe, other)) ||
        roads.some((seg) => rotatedRectsOverlap(probe, roadRect(seg)));
      if (!blocked) {
        fallback = candidate;
        break;
      }
    }
    this.spillPlacements.set(locationId, fallback);
    return fallback;
  }

  private tryPlace(placed: PlacedBuilding[], plan: BuildingPlan, roads: RoadSegment[]): boolean {
    const rect: Rect = {
      x: plan.x,
      z: plan.z,
      w: plan.footprint.w,
      d: plan.footprint.d,
      rotation: plan.rotation,
    };
    if (placed.some((other) => rotatedRectsOverlap(rect, other))) return false;
    if (roads.some((seg) => rotatedRectsOverlap(rect, roadRect(seg)))) return false;
    placed.push({ ...rect, key: plan.key, districtId: plan.districtId ?? "orphan" });
    return true;
  }

  /* ----------------------------------------------------------------- decor */

  private buildDecor(
    districts: DistrictPlan[],
    placed: PlacedBuilding[],
    locations: LocationDto[],
  ): DecorPlan[] {
    const decor: DecorPlan[] = [];
    const blocked = (x: number, z: number, radius: number): boolean => {
      const probe: Rect = { x, z, w: radius * 2, d: radius * 2, rotation: 0 };
      return placed.some((other) => rotatedRectsOverlap(probe, other));
    };
    const push = (entry: Omit<DecorPlan, "tone">): void => {
      if (decor.length >= 320) return;
      if (blocked(entry.x, entry.z, 1.2)) return;
      decor.push({ ...entry, tone: hashString(entry.key) % 4 });
    };

    // Central fountain anchors the plaza.
    const centre = districts.find((entry) => entry.classification === "CITY_CENTRE");
    if (centre !== undefined) {
      decor.push({ key: "decor:fountain", kind: "FOUNTAIN", x: centre.parcel.x, z: centre.parcel.z, rotation: 0, scale: 1, tone: 0 });
    }

    // Lamps along the main avenues.
    for (const [index, seg] of buildArterials().entries()) {
      const length = Math.hypot(seg.x2 - seg.x1, seg.z2 - seg.z1);
      const ux = (seg.x2 - seg.x1) / length;
      const uz = (seg.z2 - seg.z1) / length;
      const nx = -uz;
      const nz = ux;
      for (let t = 12; t < length - 12; t += 26) {
        for (const side of [1, -1]) {
          const x = seg.x1 + ux * t + nx * side * (seg.width / 2 + 1.6);
          const z = seg.z1 + uz * t + nz * side * (seg.width / 2 + 1.6);
          push({ key: `decor:lamp:${index}:${t}:${side}`, kind: "LAMP", x, z, rotation: 0, scale: 1 });
        }
      }
    }

    // Trees and benches inside green/field patches, plus village greenery.
    for (const district of districts) {
      for (const ground of district.patches) {
        if (ground.kind !== "LAWN" && ground.kind !== "FIELD") continue;
        const cols = Math.max(1, Math.floor(ground.w / 9));
        const rows = Math.max(1, Math.floor(ground.h / 9));
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const jitter = hashString(`${ground.id}:${row}:${col}`);
            const x = ground.x - ground.w / 2 + (col + 0.5) * (ground.w / cols) + ((jitter % 100) / 100 - 0.5) * 2.5;
            const z = ground.z - ground.h / 2 + (row + 0.5) * (ground.h / rows) + (((jitter >> 7) % 100) / 100 - 0.5) * 2.5;
            push({ key: `decor:tree:${ground.id}:${row}:${col}`, kind: jitter % 5 === 0 ? "BUSH" : "TREE", x, z, rotation: (jitter % 628) / 100, scale: 0.85 + (jitter % 40) / 100 });
          }
        }
      }
    }

    // Benches face the plaza and the park paths.
    if (centre !== undefined) {
      const cx = centre.parcel.x;
      const cz = centre.parcel.z;
      const edges: ReadonlyArray<readonly [number, number, number]> = [
        [cx - 12, cz - 18, 0],
        [cx + 12, cz - 18, 0],
        [cx - 12, cz + 18, Math.PI],
        [cx + 12, cz + 18, Math.PI],
        [cx - 18, cz - 12, Math.PI / 2],
        [cx - 18, cz + 12, Math.PI / 2],
        [cx + 18, cz - 12, -Math.PI / 2],
        [cx + 18, cz + 12, -Math.PI / 2],
      ];
      for (const [x, z, rotation] of edges) {
        push({ key: `decor:bench:${x}:${z}`, kind: "BENCH", x, z, rotation, scale: 1 });
      }
    }
    const park = districts.find((entry) => entry.classification === "PUBLIC");
    if (park !== undefined) {
      const px = park.parcel.x;
      const pz = park.parcel.z;
      for (const [x, z, rotation] of [
        [px - 10, pz - 18, 0],
        [px + 10, pz - 18, 0],
        [px - 10, pz + 18, Math.PI],
        [px + 10, pz + 18, Math.PI],
      ] as ReadonlyArray<readonly [number, number, number]>) {
        push({ key: `decor:parkbench:${x}:${z}`, kind: "BENCH", x, z, rotation, scale: 1 });
      }
    }

    // Street signs at each real location corner keep the map readable.
    for (const location of locations) {
      if (decor.length >= 320) break;
      const building = placed.find((entry) => entry.key === location.id);
      if (building === undefined) continue;
      decor.push({
        key: `decor:sign:${location.id}`,
        kind: "SIGN",
        x: building.x + Math.sin(building.rotation) * (building.d / 2 + 1.4),
        z: building.z + Math.cos(building.rotation) * (building.d / 2 + 1.4),
        rotation: building.rotation,
        scale: 1,
        tone: hashString(location.id) % 3,
      });
    }
    return decor;
  }

  private resolveCityOffsets(districts: readonly DistrictDto[]): Map<string, { x: number; z: number }> {
    const cityIds = [...new Set(districts.map((district) => district.cityId))].sort();
    for (const cityId of cityIds) {
      if (!this.cityOffsets.has(cityId)) {
        // Monotonic counter, not the index in the current sorted list: a
        // newly-appearing city must never collide with an existing offset.
        this.cityOffsets.set(cityId, { x: this.cityOffsets.size * 520, z: 0 });
      }
    }
    return this.cityOffsets;
  }
}

function contextArchetypeFor(cls: DistrictClass, variant: number): BuildingArchetype {
  if (cls === "VILLAGE") return variant % 3 === 0 ? "CONTEXT_BARN" : "CONTEXT_HOUSE";
  if (cls === "RESIDENTIAL") return variant % 4 === 0 ? "TOWNHOUSE" : "CONTEXT_HOUSE";
  if (cls === "CITY_CENTRE" || cls === "COMMERCIAL") return "CONTEXT_BLOCK";
  if (cls === "INDUSTRIAL") return variant % 2 === 0 ? "WAREHOUSE" : "CONTEXT_BLOCK";
  return CONTEXT_ARCHETYPES[cls];
}

function parcelKey(parcel: Parcel): string {
  return `${parcel.x}:${parcel.z}:${parcel.w}:${parcel.h}`;
}

function applyOffset(parcel: Parcel, offset: { x: number; z: number }): Parcel {
  return { x: parcel.x + offset.x, z: parcel.z + offset.z, w: parcel.w, h: parcel.h };
}

function dedupeById<T extends { id: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** One-shot layout with a fresh engine (fully pure). */
export function computeLayout(input: LayoutInput): WorldLayoutPlan {
  return new WorldLayoutEngine().update(input);
}
