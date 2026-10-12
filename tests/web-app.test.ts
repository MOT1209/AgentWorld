import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../packages/shared/src/index.js";
import { createApp } from "../apps/api/src/app.js";

describe("serving the built dashboard (SERVE_WEB)", () => {
  let dist: string;
  const previous = { serve: process.env.SERVE_WEB, dir: process.env.WEB_DIST_DIR };

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "agentworld-web-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>shell</title>");
    writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log('ok');");
    process.env.SERVE_WEB = "1";
    process.env.WEB_DIST_DIR = dist;
    resetConfigCache();
  });

  afterAll(() => {
    if (previous.serve === undefined) delete process.env.SERVE_WEB;
    else process.env.SERVE_WEB = previous.serve;
    if (previous.dir === undefined) delete process.env.WEB_DIST_DIR;
    else process.env.WEB_DIST_DIR = previous.dir;
    resetConfigCache();
    rmSync(dist, { recursive: true, force: true });
  });

  it("serves the HTML shell at / and for client-side routes", async () => {
    const app = createApp();
    for (const path of ["/", "/some/deep/link"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("<title>shell</title>");
    }
  });

  it("serves hashed assets as immutable", async () => {
    const res = await request(createApp()).get("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("keeps a missing file a 404 instead of answering with the HTML shell", async () => {
    const res = await request(createApp()).get("/assets/missing-file.js");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("<title>shell</title>");
  });

  it("leaves the API, health and readiness endpoints alone", async () => {
    const app = createApp();
    expect((await request(app).get("/health")).body.ok).toBe(true);
    expect((await request(app).get("/ready")).status).toBe(200);
    const unknown = await request(app).get("/api/v1/does-not-exist");
    expect(unknown.status).toBe(404);
    expect(unknown.headers["content-type"]).toMatch(/json/);
    const unauthenticated = await request(app).get("/api/v1/agents");
    expect(unauthenticated.status).toBe(401);
  });

  it("refuses to start when the dashboard build is missing", () => {
    process.env.WEB_DIST_DIR = join(dist, "nope");
    resetConfigCache();
    expect(() => createApp()).toThrow(/npm run build:web/);
    process.env.WEB_DIST_DIR = dist;
    resetConfigCache();
  });

  it("does not serve anything when SERVE_WEB is off", async () => {
    delete process.env.SERVE_WEB;
    resetConfigCache();
    const res = await request(createApp()).get("/");
    expect(res.status).toBe(404);
    process.env.SERVE_WEB = "1";
    resetConfigCache();
  });
});
