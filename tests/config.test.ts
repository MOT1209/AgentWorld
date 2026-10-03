import { describe, it, expect, afterEach } from "vitest";
import { getConfig, resetConfigCache } from "../packages/shared/src/index.js";

const savedEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const key of ["NODE_ENV", "JWT_SECRET", "DATABASE_URL", "SEED_OWNER_PASSWORD", "EXEC_SANDBOX"] as const) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
}

describe("production config guards", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("refuses a weak JWT secret in production", () => {
    snapshotEnv();
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "too-short";
    process.env.DATABASE_URL = "file:./test-config.db";
    resetConfigCache();
    expect(() => getConfig()).toThrow();
  });

  it("refuses the development placeholder secret in production", () => {
    snapshotEnv();
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "dev-only-insecure-secret-change-me";
    process.env.DATABASE_URL = "file:./test-config.db";
    resetConfigCache();
    expect(() => getConfig()).toThrow();
  });

  it("refuses the default seed password in production", () => {
    snapshotEnv();
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a".repeat(48);
    process.env.SEED_OWNER_PASSWORD = "KingWorld!2026";
    process.env.DATABASE_URL = "file:./test-config.db";
    resetConfigCache();
    expect(() => getConfig()).toThrow();
  });

  it("boots with the dev fallback outside production", () => {
    snapshotEnv();
    process.env.NODE_ENV = "test";
    delete process.env.JWT_SECRET;
    resetConfigCache();
    const config = getConfig();
    expect(config.jwt.secret.length).toBeGreaterThan(0);
  });
});

describe("command sandbox default", () => {
  afterEach(() => {
    restoreEnv();
  });

  function production(): void {
    snapshotEnv();
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a".repeat(48);
    process.env.SEED_OWNER_PASSWORD = "Another-Strong-Pass-1";
    process.env.DATABASE_URL = "file:./test-config.db";
    delete process.env.EXEC_SANDBOX;
    resetConfigCache();
  }

  it("defaults to docker in production", () => {
    production();
    expect(getConfig().exec.sandbox).toBe("docker");
  });

  it("defaults to local outside production", () => {
    snapshotEnv();
    process.env.NODE_ENV = "test";
    delete process.env.EXEC_SANDBOX;
    resetConfigCache();
    expect(getConfig().exec.sandbox).toBe("local");
  });

  it("still honours an explicit EXEC_SANDBOX in production", () => {
    production();
    process.env.EXEC_SANDBOX = "local";
    resetConfigCache();
    expect(getConfig().exec.sandbox).toBe("local");
  });
});
