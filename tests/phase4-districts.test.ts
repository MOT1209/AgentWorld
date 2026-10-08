/**
 * Phase 4: districts + location geometry + capacity enforcement.
 *
 * A district is a city sub-area (geometry metadata only, no pathfinding).
 * Locations may belong to a district; capacity is enforced server-side on
 * `moveAgent` and surfaced through the snapshot the dashboard reads.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { prisma } from "../packages/database/src/client.js";
import {
  createWorld,
  createCity,
  createLocation,
  createDistrict,
  listDistricts,
  getWorldSnapshot,
  moveAgent,
} from "../packages/world/src/index.js";
import { eventBus, EVENT_TYPES } from "../packages/events/src/index.js";
import { listActivity } from "../packages/events/src/audit.js";
import { worldGetStateTool } from "../packages/tools/src/definitions/world-tools.js";
import { createApp } from "../apps/api/src/app.js";
import { hashPassword } from "../packages/security/src/password.js";
import { SYSTEM, CORRELATION, createTestAgent, unique } from "./helpers.js";

async function fixture(): Promise<{ worldId: string; cityId: string }> {
  const world = await createWorld(
    prisma,
    { name: unique("World") },
    { actor: SYSTEM, correlationId: CORRELATION },
  );
  const city = await createCity(
    prisma,
    { worldId: world.id, name: unique("City") },
    { actor: SYSTEM },
  );
  return { worldId: world.id, cityId: city.id };
}

describe("phase4 districts", () => {
  it("creates districts, assigns locations, and exposes them in the snapshot", async () => {
    const { worldId, cityId } = await fixture();

    let seen = 0;
    const off = eventBus.subscribe(EVENT_TYPES.DISTRICT_CREATED, () => {
      seen += 1;
    });

    const district = await createDistrict(
      prisma,
      {
        cityId,
        name: unique("Old Town"),
        kind: "COMMERCIAL",
        description: "Historic centre",
        geometry: { center: { x: 12, y: 34 }, bounds: [0, 0, 100, 80] },
      },
      { actor: SYSTEM, correlationId: CORRELATION },
    );
    off();
    expect(seen).toBe(1);
    expect(district.cityId).toBe(cityId);
    expect(JSON.parse(district.geometry ?? "{}")).toMatchObject({
      center: { x: 12, y: 34 },
    });

    const location = await createLocation(
      prisma,
      { cityId, name: unique("Bakery"), kind: "SHOP", districtId: district.id },
      { actor: SYSTEM },
    );
    expect(location.districtId).toBe(district.id);

    const districts = await listDistricts(prisma, { cityId });
    const mine = districts.find((d) => d.id === district.id);
    expect(mine).toBeDefined();
    expect(mine?.locationCount).toBeGreaterThanOrEqual(1);

    const snapshot = await getWorldSnapshot(prisma, worldId);
    const snapDistrict = snapshot.districts.find((d) => d.id === district.id);
    expect(snapDistrict).toBeDefined();
    expect(snapDistrict?.locationCount).toBeGreaterThanOrEqual(1);
    const snapLocation = snapshot.locations.find((l) => l.id === location.id);
    expect(snapLocation?.districtId).toBe(district.id);

    const activity = await listActivity(prisma, { action: "world.create_district", take: 5 });
    expect(activity.length).toBeGreaterThan(0);
  });

  it("rejects duplicate districts, cross-city district assignment, and unknown districts", async () => {
    const { cityId } = await fixture();
    const other = await createCity(
      prisma,
      { worldId: (await prisma.city.findUniqueOrThrow({ where: { id: cityId } })).worldId, name: unique("Other City") },
      { actor: SYSTEM },
    );

    const district = await createDistrict(
      prisma,
      { cityId, name: unique("Riverside"), kind: "RESIDENTIAL" },
      { actor: SYSTEM },
    );

    await expect(
      createDistrict(prisma, { cityId, name: district.name, kind: "RESIDENTIAL" }, { actor: SYSTEM }),
    ).rejects.toThrow(/already exists/i);

    // District of another city cannot hold this city's location.
    await expect(
      createLocation(prisma, { cityId, name: unique("Loft"), kind: "HOME", districtId: district.id }, { actor: SYSTEM }),
    ).resolves.toBeDefined();

    const foreign = await createDistrict(
      prisma,
      { cityId: other.id, name: unique("Harbor"), kind: "INDUSTRIAL" },
      { actor: SYSTEM },
    );
    await expect(
      createLocation(
        prisma,
        { cityId, name: unique("Wrong City Loft"), kind: "HOME", districtId: foreign.id },
        { actor: SYSTEM },
      ),
    ).rejects.toThrow(/district/i);

    await expect(
      createLocation(
        prisma,
        { cityId, name: unique("Ghost Loft"), kind: "HOME", districtId: "missing-district" },
        { actor: SYSTEM },
      ),
    ).rejects.toThrow(/district/i);
  });

  it("enforces capacity on moveAgent and reports denials", async () => {
    const { worldId, cityId } = await fixture();
    const tight = await createLocation(
      prisma,
      { cityId, name: unique("Phone Booth"), kind: "PUBLIC_SPACE", capacity: 1 },
      { actor: SYSTEM },
    );
    const roomy = await createLocation(
      prisma,
      { cityId, name: unique("Plaza"), kind: "PUBLIC_SPACE" },
      { actor: SYSTEM },
    );

    const a = await createTestAgent({ name: unique("A"), worldId });
    const b = await createTestAgent({ name: unique("B"), worldId });

    await moveAgent(prisma, { agentId: a.id, toLocationId: tight.id }, { actor: SYSTEM });
    await expect(
      moveAgent(prisma, { agentId: b.id, toLocationId: tight.id }, { actor: SYSTEM }),
    ).rejects.toThrow(/capacity/i);

    // Leaving a full location is always allowed, and frees the slot.
    await moveAgent(prisma, { agentId: a.id, toLocationId: null }, { actor: SYSTEM });
    await moveAgent(prisma, { agentId: b.id, toLocationId: tight.id }, { actor: SYSTEM });

    // No capacity -> unlimited.
    await moveAgent(prisma, { agentId: a.id, toLocationId: roomy.id }, { actor: SYSTEM });

    const snapshot = await getWorldSnapshot(prisma, worldId);
    const tightSnap = snapshot.locations.find((l) => l.id === tight.id);
    expect(tightSnap?.capacity).toBe(1);
    expect(tightSnap?.occupantCount).toBe(1);

    const denied = await listActivity(prisma, { action: "world.move_agent_denied", take: 5 });
    expect(denied.length).toBeGreaterThan(0);
  });

  it("advertises districts and capacity through world.get_state", async () => {
    const { worldId, cityId } = await fixture();
    const district = await createDistrict(
      prisma,
      { cityId, name: unique("Market Ward"), kind: "COMMERCIAL" },
      { actor: SYSTEM },
    );
    await createLocation(
      prisma,
      { cityId, name: unique("Stall"), kind: "MARKET", capacity: 3, districtId: district.id },
      { actor: SYSTEM },
    );

    const out = await worldGetStateTool.execute(
      {
        actor: SYSTEM,
        correlationId: CORRELATION,
        permissions: new Set(["world.read"]),
        db: prisma,
        worldId,
        now: new Date(),
      },
      {},
    );
    const data = out.data as {
      districts: Array<{ id: string; locationCount: number }>;
      locations: Array<{ id: string; capacity: number | null; occupantCount: number }>;
    };
    expect(data.districts.some((d) => d.id === district.id)).toBe(true);
    const loc = data.locations.find((l) => l.capacity === 3);
    expect(loc).toBeDefined();
    expect(loc?.occupantCount).toBe(0);
    expect(out.summary).toMatch(/district/i);
  });
});

describe("phase4 district api", () => {
  it("exposes district create/list over REST with enforcement", async () => {
    const app = createApp();
    const email = `${unique("owner")}@test.local`.toLowerCase();
    await prisma.user.create({
      data: {
        email,
        passwordHash: hashPassword("TestPassword123", 10),
        displayName: "Owner",
        role: "OWNER",
        isActive: true,
      },
    });
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: "TestPassword123" });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.token as string}` };

    const { cityId } = await fixture();
    const name = unique("REST District");
    const created = await request(app)
      .post("/api/v1/world/districts")
      .set(auth)
      .send({ cityId, name, kind: "CIVIC", geometry: { center: { x: 1, y: 2 } } });
    expect(created.status).toBe(201);
    expect(created.body.data.name).toBe(name);

    const dup = await request(app)
      .post("/api/v1/world/districts")
      .set(auth)
      .send({ cityId, name, kind: "CIVIC" });
    expect(dup.status).toBe(409);

    const list = await request(app).get(`/api/v1/world/districts?cityId=${cityId}`).set(auth);
    expect(list.status).toBe(200);
    expect(list.body.data.some((d: { name: string }) => d.name === name)).toBe(true);

    const invalid = await request(app)
      .post("/api/v1/world/districts")
      .set(auth)
      .send({ cityId: "nope", name: "x" });
    expect(invalid.status).toBe(404);
  });
});
