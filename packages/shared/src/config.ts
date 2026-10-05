/**
 * Central configuration.
 *
 * Rules:
 *  - Secrets are read once, validated, and never exported in a form that a
 *    response DTO could accidentally serialise. `redactedConfig()` is the only
 *    shape intended for any external surface.
 *  - In production a missing/weak JWT secret is fatal at boot, not a warning.
 *  - Nothing here reaches the browser bundle.
 */
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(4000, 1, 65535),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z.string().default(""),
  JWT_EXPIRES_IN: z.string().default("12h"),
  BCRYPT_ROUNDS: int(12, 10, 15),

  CORS_ORIGINS: csv,
  // Number of reverse proxies in front of the API (req.ip / rate limits). 0 = none.
  TRUST_PROXY: int(0, 0, 10),

  SEED_OWNER_EMAIL: z.string().email().default("king@kingworld.local"),
  SEED_OWNER_PASSWORD: z.string().min(10).default("KingWorld!2026"),

  DEFAULT_PROVIDER: z.string().default("mock"),
  OPENAI_COMPATIBLE_ENABLED: bool(false),
  OPENAI_COMPATIBLE_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_COMPATIBLE_API_KEY: z.string().default(""),
  ANTHROPIC_ENABLED: bool(false),
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com/v1"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_VERSION: z.string().default("2023-06-01"),
  GOOGLE_ENABLED: bool(false),
  GOOGLE_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta"),
  GOOGLE_API_KEY: z.string().default(""),

  AGENT_MAX_TOOL_ITERATIONS: int(8, 1, 50),
  AGENT_REQUEST_TIMEOUT_MS: int(120_000, 1_000, 600_000),

  APPROVAL_ENABLED: bool(true),
  APPROVAL_SPEND_THRESHOLD: int(1000, 0),
  APPROVAL_TTL_HOURS: int(24, 1),

  WORLD_TIME_SCALE: int(60, 1),

  // Execution runtime (Phase 3). OPENCODE_COMMAND names the binary for the
  // opencode backend — the ONLY config reference to it besides that backend.
  EXECUTION_BACKEND: z.enum(["local", "mock", "opencode"]).default("local"),
  OPENCODE_COMMAND: z.string().min(1).default("opencode"),
  // No schema default: production defaults to docker, everything else to local.
  EXEC_SANDBOX: z.enum(["local", "docker"]).optional(),
  EXEC_DOCKER_IMAGE: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/, "invalid image reference").default("kingworld-sandbox:1"),
  // Empty = the owner of the workspace directory (must not be root). Otherwise "uid:gid".
  EXEC_DOCKER_USER: z.string().regex(/^([0-9]+:[0-9]+)?$/, "must be uid:gid").default(""),
  EXEC_DOCKER_MEMORY: z.string().regex(/^[0-9]+[kmg]$/i, "e.g. 512m").default("512m"),
  EXEC_DOCKER_CPUS: z.string().regex(/^[0-9]+(\.[0-9]+)?$/, "e.g. 1 or 0.5").default("1"),
  EXEC_DOCKER_PIDS: int(256, 16, 4096),
});

export type RawConfig = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  databaseUrl: string;
  jwt: { secret: string; expiresIn: string };
  bcryptRounds: number;
  corsOrigins: string[];
  trustProxy: number;
  seed: { ownerEmail: string; ownerPassword: string };
  providers: {
    defaultProviderId: string;
    openaiCompatible: { enabled: boolean; baseUrl: string; apiKey: string };
    anthropic: { enabled: boolean; baseUrl: string; apiKey: string; version: string };
    google: { enabled: boolean; baseUrl: string; apiKey: string };
  };
  agent: { maxToolIterations: number; requestTimeoutMs: number };
  approvals: { enabled: boolean; spendThresholdMinor: number; ttlHours: number };
  world: { timeScale: number };
  execution: { defaultBackend: "local" | "mock" | "opencode"; openCodeCommand: string };
  exec: {
    sandbox: "local" | "docker";
    docker: { image: string; user: string; memory: string; cpus: string; pids: number };
  };
}

const DEV_ONLY_SECRET = "dev-only-insecure-secret-change-me";

function load(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        "Hint: if this is a fresh checkout, copy the example env file first:\n" +
        "  cp .env.example .env",
    );
  }
  const raw: RawConfig = parsed.data;

  const isProduction = raw.NODE_ENV === "production";

  let secret = raw.JWT_SECRET;
  if (!secret) {
    if (isProduction) {
      throw new Error(
        "JWT_SECRET must be set in production. Generate one with: openssl rand -hex 48",
      );
    }
    secret = DEV_ONLY_SECRET;
  }
  if (isProduction && secret === DEV_ONLY_SECRET) {
    throw new Error("JWT_SECRET is still the development placeholder. Refusing to start.");
  }
  if (isProduction && secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters in production.");
  }

  if (raw.SEED_OWNER_PASSWORD === "KingWorld!2026" && isProduction) {
    throw new Error("SEED_OWNER_PASSWORD is still the development default. Refusing to start.");
  }

  const defaultProviderId = raw.DEFAULT_PROVIDER;
  const hasAnyProviderKey =
    raw.OPENAI_COMPATIBLE_API_KEY !== "" ||
    raw.ANTHROPIC_API_KEY !== "" ||
    raw.GOOGLE_API_KEY !== "";

  return {
    env: raw.NODE_ENV,
    isProduction,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    databaseUrl: raw.DATABASE_URL,
    jwt: { secret, expiresIn: raw.JWT_EXPIRES_IN },
    bcryptRounds: raw.BCRYPT_ROUNDS,
    corsOrigins: raw.CORS_ORIGINS,
    trustProxy: raw.TRUST_PROXY,
    seed: { ownerEmail: raw.SEED_OWNER_EMAIL, ownerPassword: raw.SEED_OWNER_PASSWORD },
    providers: {
      defaultProviderId,
      openaiCompatible: {
        enabled: raw.OPENAI_COMPATIBLE_ENABLED && raw.OPENAI_COMPATIBLE_API_KEY !== "",
        baseUrl: raw.OPENAI_COMPATIBLE_BASE_URL,
        apiKey: raw.OPENAI_COMPATIBLE_API_KEY,
      },
      anthropic: {
        enabled: raw.ANTHROPIC_ENABLED && raw.ANTHROPIC_API_KEY !== "",
        baseUrl: raw.ANTHROPIC_BASE_URL,
        apiKey: raw.ANTHROPIC_API_KEY,
        version: raw.ANTHROPIC_VERSION,
      },
      google: {
        enabled: raw.GOOGLE_ENABLED && raw.GOOGLE_API_KEY !== "",
        baseUrl: raw.GOOGLE_BASE_URL,
        apiKey: raw.GOOGLE_API_KEY,
      },
    },
    agent: {
      maxToolIterations: raw.AGENT_MAX_TOOL_ITERATIONS,
      requestTimeoutMs: raw.AGENT_REQUEST_TIMEOUT_MS,
    },
    approvals: {
      enabled: raw.APPROVAL_ENABLED,
      spendThresholdMinor: raw.APPROVAL_SPEND_THRESHOLD * 100,
      ttlHours: raw.APPROVAL_TTL_HOURS,
    },
    world: { timeScale: raw.WORLD_TIME_SCALE },
    execution: {
      defaultBackend: raw.EXECUTION_BACKEND,
      openCodeCommand: raw.OPENCODE_COMMAND,
    },
    exec: {
      sandbox: raw.EXEC_SANDBOX ?? (isProduction ? "docker" : "local"),
      docker: {
        image: raw.EXEC_DOCKER_IMAGE,
        user: raw.EXEC_DOCKER_USER,
        memory: raw.EXEC_DOCKER_MEMORY,
        cpus: raw.EXEC_DOCKER_CPUS,
        pids: raw.EXEC_DOCKER_PIDS,
      },
    },
    // Surfaced by hasAnyProviderKey callers; kept out of the object shape to
    // avoid it being read as configuration.
    ...(hasAnyProviderKey ? {} : {}),
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached === null) cached = load();
  return cached;
}

/** Test hook: forces the next getConfig() to re-read the environment. */
export function resetConfigCache(): void {
  cached = null;
}

/** Only shape safe to expose on any external surface. */
export function redactedConfig(config: AppConfig = getConfig()): Record<string, unknown> {
  return {
    env: config.env,
    port: config.port,
    logLevel: config.logLevel,
    corsOrigins: config.corsOrigins,
    approvals: {
      enabled: config.approvals.enabled,
      spendThresholdMinor: config.approvals.spendThresholdMinor,
      ttlHours: config.approvals.ttlHours,
    },
    agent: config.agent,
    world: config.world,
    execution: config.execution,
    exec: config.exec,
    providers: {
      defaultProviderId: config.providers.defaultProviderId,
      openaiCompatible: { enabled: config.providers.openaiCompatible.enabled },
      anthropic: { enabled: config.providers.anthropic.enabled },
      google: { enabled: config.providers.google.enabled },
    },
  };
}
