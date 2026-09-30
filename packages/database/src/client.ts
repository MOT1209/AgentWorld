/**
 * Prisma client lifecycle.
 *
 * A single instance per process. In development the file watcher reloads the
 * module graph on every edit, which would otherwise leak a connection pool per
 * reload -- hence the `globalThis` cache.
 */
import { PrismaClient } from "@prisma/client";
import { getConfig, logger } from "../../shared/src/index.js";

const globalForPrisma = globalThis as unknown as { __kingworldPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__kingworldPrisma ??
  new PrismaClient({
    log: getConfig().logLevel === "debug" ? ["warn", "error"] : ["error"],
  });

if (!getConfig().isProduction) {
  globalForPrisma.__kingworldPrisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info("Database connected", { action: "database.connect" });
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info("Database disconnected", { action: "database.disconnect" });
}

export async function databaseHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : "unknown",
    };
  }
}
