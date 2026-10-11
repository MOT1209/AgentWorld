import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";

/**
 * Writes a consistent, compacted copy of the live SQLite database with `VACUUM INTO`.
 *
 * Safe while the API is running (it reads a snapshot) and the copy is a normal database file, so
 * restoring is "stop the API, replace the file, start". Refuses to overwrite: a backup that silently
 * replaces an older one is how you lose both.
 */
export async function backupDatabase(prisma: PrismaClient, target: string): Promise<string> {
  const file = resolve(target);
  if (existsSync(file)) throw new Error(`Refusing to overwrite existing backup: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  // VACUUM INTO takes a string literal, not a bound parameter: escape quotes by doubling them.
  const literal = file.replace(/'/g, "''");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${literal}'`);
  return file;
}

/** `backups/agentworld-2026-10-11T12-00-00-000Z.db` (colons are not valid in Windows file names). */
export function defaultBackupPath(now: Date = new Date()): string {
  return `backups/agentworld-${now.toISOString().replace(/[:.]/g, "-")}.db`;
}
