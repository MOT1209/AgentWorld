/**
 * Layout engine invariants: determinism, sticky lots, no building-road
 * overlap, operator pins, multi-city offsets, context filler, orphans.
 *
 * Pure data (no three.js, no DOM) — runs in the Node test environment.
 */
import { describe, it, expect } from "vitest";
import {
  GROUND_SIZE,
  WorldLayoutEngine,
  classifyDistrict,
  computeLayout,
  footprintFor,
  rotatedRectsOverlap,
} from "../apps/web/src/world/layout.js";
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

const CITY = district({ id: "d-centre", cityId: "c-1", name: "Altstadt", kind: "CITY_CENTRE" });
const RESI = district({ id: "d-resi", cityId: "c-1", name: "Wohnviertel", kind: "RESIDENTIAL" });
const COMMERCE = district({ id: "d-com", cityId: "c-1", name: "Gewerbe", kind: "BUSINESS" });
const PARK = district({ id: "d-park", cityId: "c-1", name: "Stadtpark", kind: "PUBLIC" });
const VILLAGE = district({ id: "d-village", cityId: "c-1", name: "Dorf", kind: "VILLAGE" });

function sampleDistricts(): DistrictDto[] {
  return [CITY, RESI, COMMERCE, PARK, VILLAGE];
}

function sampleLocations(): LocationDto[] {
  return [
    location({ id: "loc-hq", name: "HQ", kind: "HQ", cityId: "c-1", districtId: "d-centre", occupantCount: 4 }),
    location({ id: "loc-shop", name: "Shop", kind: "SHOP", cityId: "c-1", districtId: "d-centre" }),
    location({ id: "loc-house", name: "House", kind: "HOME", cityId: "c-1", districtId: "d-resi", capacity: 4 }),
    location({ id: "loc-office", name: "Office", kind: "OFFICE", cityId: "c-1", districtId: "d-com" }),
    location({ id: "loc-barn", name: "Barn", kind: "BARN", cityId: "c-1", districtId: "d-village" }),
  ];
}

describe("classifyDistrict", () => {
  it("maps seeded kinds and name hints", () => {
    expect(classifyDistrict("CITY_CENTRE", null)).toBe("CITY_CENTRE");
    expect(classifyDistrict("BUSINESS", null)).toBe("COMMERCIAL");
    expect(classifyDistrict("PUBLIC", null)).toBe("PUBLIC");
    expect(classifyDistrict(null, "Downtown Plaza")).toBe("CITY_CENTRE");
    expect(classifyDistrict(null, "Wohnpark")).toBe("RESIDENTIAL");
    expect(classifyDistrict(null, "Mystery Zone")).toBe("GENERIC");
  });
});

describe("rotatedRectsOverlap (SAT)", () => {
  it("detects overlap between a rotated long box and a perpendicular box", () => {
    // 3π/4 rotation makes abs(a+b) < abs(a-b), which the old inverted SAT
    // formula treated as separation. This pair DOES overlap.
    const a = { x: 0, z: 0, w: 10, d: 2, rotation: (3 * Math.PI) / 4 };
    const b = { x: 3.5, z: 0, w: 1, d: 10, rotation: 0 };
    expect(rotatedRectsOverlap(a, b)).toBe(true);
  });

  it("reports separation for distant rects and for merely touching edges", () => {
    const a = { x: 0, z: 0, w: 10, d: 2, rotation: 0 };
    const far = { x: 50, z: 50, w: 4, d: 4, rotation: 0 };
    const touching = { x: 7, z: 0, w: 4, d: 4, rotation: 0 }; // edges at x=5
    expect(rotatedRectsOverlap(a, far)).toBe(false);
    expect(rotatedRectsOverlap(a, touching)).toBe(false);
  });
});

describe("computeLayout", () => {
  it("is deterministic for the same input", () => {
    const input = { districts: sampleDistricts(), locations: sampleLocations() };
    const a = computeLayout(input);
    const b = computeLayout(input);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("emits a fixed ground size and arterials through the origin", () => {
    const plan = computeLayout({ districts: sampleDistricts(), locations: sampleLocations() });
    expect(plan.groundSize).toBe(GROUND_SIZE);
    expect(plan.arterials.length).toBeGreaterThanOrEqual(2);
    const crossesOrigin = plan.arterials.some(
      (seg) =>
        (seg.x1 <= 0 && seg.x2 >= 0 && seg.z1 === 0 && seg.z2 === 0) ||
        (seg.z1 <= 0 && seg.z2 >= 0 && seg.x1 === 0 && seg.x2 === 0),
    );
    expect(crossesOrigin).toBe(true);
  });

  it("places every real location as a selectable building keyed by location id", () => {
    const plan = computeLayout({ districts: sampleDistricts(), locations: sampleLocations() });
    const real = plan.buildings.filter((b) => b.locationId !== null);
    expect(real.map((b) => b.key).sort()).toEqual(
      ["loc-barn", "loc-house", "loc-hq", "loc-office", "loc-shop"].sort(),
    );
    for (const b of real) {
      expect(b.selectable).toBe(true);
      expect(b.context).toBe(false);
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.z)).toBe(true);
      expect(b.footprint.w).toBeGreaterThan(0);
    }
  });

  it("keeps real buildings off every road (SAT vs road AABB, same as placement)", () => {
    const plan = computeLayout({ districts: sampleDistricts(), locations: sampleLocations() });
    const allRoads = [...plan.arterials, ...plan.districts.flatMap((d) => d.roads)];
    expect(allRoads.length).toBeGreaterThan(0);

    const roadRect = (seg: (typeof allRoads)[number]): { x: number; z: number; w: number; d: number; rotation: number } => ({
      x: (seg.x1 + seg.x2) / 2,
      z: (seg.z1 + seg.z2) / 2,
      w: Math.abs(seg.x2 - seg.x1) + seg.width,
      d: Math.abs(seg.z2 - seg.z1) + seg.width,
      rotation: 0,
    });

    for (const b of plan.buildings.filter((x) => !x.context)) {
      const rect = {
        x: b.x,
        z: b.z,
        w: b.footprint.w,
        d: b.footprint.d,
        rotation: b.rotation,
      };
      for (const seg of allRoads) {
        expect(rotatedRectsOverlap(rect, roadRect(seg))).toBe(false);
      }
    }
  });

  it("fills free lots with non-selectable context buildings when asked", () => {
    const withCtx = computeLayout({
      districts: sampleDistricts(),
      locations: sampleLocations(),
      includeContext: true,
    });
    const without = computeLayout({
      districts: sampleDistricts(),
      locations: sampleLocations(),
      includeContext: false,
    });
    expect(withCtx.buildings.some((b) => b.context && !b.selectable)).toBe(true);
    expect(without.buildings.some((b) => b.context)).toBe(false);
    expect(withCtx.buildings.filter((b) => !b.context).length).toBe(
      without.buildings.filter((b) => !b.context).length,
    );
  });

  it("honours operator pins from location.metadata (object and JSON string)", () => {
    const pinnedObject = location({
      id: "loc-pin",
      name: "Pinned",
      kind: "HOUSE",
      cityId: "c-1",
      districtId: "d-resi",
      metadata: { x: 12, z: -34, rotation: Math.PI / 2 },
    });
    const pinnedString = location({
      id: "loc-pin-str",
      name: "PinnedStr",
      kind: "HOUSE",
      cityId: "c-1",
      districtId: "d-resi",
      metadata: JSON.stringify({ x: -5, z: 7 }),
    });
    const plan = computeLayout({
      districts: sampleDistricts(),
      locations: [pinnedObject, pinnedString],
    });
    const a = plan.buildings.find((b) => b.key === "loc-pin");
    const b = plan.buildings.find((b) => b.key === "loc-pin-str");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.x).toBe(12);
    expect(a?.z).toBe(-34);
    expect(a?.rotation).toBeCloseTo(Math.PI / 2);
    expect(b?.x).toBe(-5);
    expect(b?.z).toBe(7);
  });

  it("pins a district parcel from district.geometry", () => {
    const pinned = district({
      id: "d-pin",
      cityId: "c-1",
      name: "Pinned District",
      kind: "GENERIC",
      geometry: { center: { x: 200, y: -150 }, bounds: [200, -150, 40, 40] },
    });
    const loc = location({
      id: "loc-in-pin",
      name: "InPin",
      kind: "HOUSE",
      cityId: "c-1",
      districtId: "d-pin",
    });
    const plan = computeLayout({ districts: [pinned], locations: [loc] });
    const dp = plan.districts.find((d) => d.id === "d-pin");
    expect(dp?.parcel.x).toBe(200);
    expect(dp?.parcel.z).toBe(-150);
    expect(dp?.parcel.w).toBe(40);
    const building = plan.buildings.find((b) => b.key === "loc-in-pin");
    expect(building).toBeDefined();
    // Inside the pinned parcel bounds.
    expect(Math.abs((building?.x ?? 0) - 200)).toBeLessThanOrEqual(20);
    expect(Math.abs((building?.z ?? 0) + 150)).toBeLessThanOrEqual(20);
  });

  it("offsets a second city so parcels never overlap", () => {
    const city2 = { ...CITY, id: "d-centre-2", cityId: "c-2", cityName: "Neustadt" };
    const resi2 = { ...RESI, id: "d-resi-2", cityId: "c-2", cityName: "Neustadt" };
    const loc2 = location({
      id: "loc-hq-2",
      name: "HQ2",
      kind: "HQ",
      cityId: "c-2",
      cityName: "Neustadt",
      districtId: "d-centre-2",
    });
    const plan = computeLayout({
      districts: [CITY, RESI, city2, resi2],
      locations: [
        location({ id: "loc-hq", name: "HQ", kind: "HQ", cityId: "c-1", districtId: "d-centre" }),
        loc2,
      ],
    });
    const p1 = plan.districts.find((d) => d.id === "d-centre");
    const p2 = plan.districts.find((d) => d.id === "d-centre-2");
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1?.parcel.x).not.toBe(p2?.parcel.x);
    const sepX = Math.abs((p1?.parcel.x ?? 0) - (p2?.parcel.x ?? 0));
    const sepZ = Math.abs((p1?.parcel.z ?? 0) - (p2?.parcel.z ?? 0));
    expect(sepX > 50 || sepZ > 50).toBe(true);
  });

  it("drops orphan locations (unknown district) onto the orphan parcel", () => {
    const orphan = location({
      id: "loc-orphan",
      name: "Orphan",
      kind: "HOUSE",
      cityId: "c-1",
      districtId: null,
    });
    const plan = computeLayout({ districts: sampleDistricts(), locations: [orphan] });
    const b = plan.buildings.find((x) => x.key === "loc-orphan");
    expect(b).toBeDefined();
    expect(b?.districtId).toBeNull();
    // ORPHAN_PARCEL is centred at (-170, 100) with 56×56.
    expect(Math.abs((b?.x ?? 0) + 170)).toBeLessThanOrEqual(28);
    expect(Math.abs((b?.z ?? 0) - 100)).toBeLessThanOrEqual(28);
  });

  it("uses distinct lots for distinct locations (no duplicate keys)", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      location({
        id: `loc-n-${i}`,
        name: `N${i}`,
        kind: "HOME",
        cityId: "c-1",
        districtId: "d-resi",
      }),
    );
    const plan = computeLayout({ districts: [RESI], locations: many });
    const keys = plan.buildings.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    const positions = plan.buildings.map((b) => `${b.x.toFixed(2)}:${b.z.toFixed(2)}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("gives every real location a footprint consistent with its archetype", () => {
    const plan = computeLayout({ districts: sampleDistricts(), locations: sampleLocations() });
    for (const b of plan.buildings.filter((x) => x.locationId !== null)) {
      const fp = footprintFor(b.archetype);
      expect(b.footprint).toEqual(fp);
      expect(b.footprint.h).toBeGreaterThan(0);
    }
  });
});

describe("WorldLayoutEngine stickiness", () => {
  it("keeps existing locations on their lots across refreshes", () => {
    const engine = new WorldLayoutEngine();
    const districts = sampleDistricts();
    const locations = sampleLocations();
    const first = engine.update({ districts, locations });
    const firstPositions = new Map(
      first.buildings
        .filter((b) => b.locationId !== null)
        .map((b) => [b.locationId as string, { x: b.x, z: b.z, rotation: b.rotation }] as const),
    );

    // Same data again — positions must not move.
    const second = engine.update({ districts, locations });
    for (const b of second.buildings.filter((x) => x.locationId !== null)) {
      const prev = firstPositions.get(b.locationId as string);
      expect(prev).toBeDefined();
      expect(b.x).toBeCloseTo(prev?.x ?? NaN, 6);
      expect(b.z).toBeCloseTo(prev?.z ?? NaN, 6);
      expect(b.rotation).toBeCloseTo(prev?.rotation ?? NaN, 6);
    }
  });

  it("keeps existing lots when a new location is added", () => {
    const engine = new WorldLayoutEngine();
    const districts = [RESI];
    const base = [
      location({ id: "loc-a", name: "A", kind: "HOME", cityId: "c-1", districtId: "d-resi" }),
    ];
    const first = engine.update({ districts, locations: base });
    const a0 = first.buildings.find((b) => b.key === "loc-a");
    expect(a0).toBeDefined();

    const extended = engine.update({
      districts,
      locations: [
        ...base,
        location({ id: "loc-b", name: "B", kind: "HOME", cityId: "c-1", districtId: "d-resi" }),
      ],
    });
    const a1 = extended.buildings.find((b) => b.key === "loc-a");
    const b1 = extended.buildings.find((b) => b.key === "loc-b");
    expect(a1).toBeDefined();
    expect(b1).toBeDefined();
    expect(a1?.x).toBe(a0?.x);
    expect(a1?.z).toBe(a0?.z);
    expect(`${b1?.x}:${b1?.z}`).not.toBe(`${a1?.x}:${a1?.z}`);
  });

  it("reset() forgets sticky state so a new world gets fresh parcels", () => {
    const engine = new WorldLayoutEngine();
    const districts = sampleDistricts();
    const locations = sampleLocations();
    const before = engine.update({ districts, locations });
    engine.reset();
    const after = engine.update({ districts, locations });
    // After reset the pure recomputation must match a fresh engine.
    const fresh = computeLayout({ districts, locations });
    expect(JSON.stringify(after)).toBe(JSON.stringify(fresh));
    expect(JSON.stringify(before)).toBe(JSON.stringify(after));
  });
});
