/* eslint-disable no-console */
/**
 * Applies one migration directory to the database in DATABASE_URL.
 *
 * The Prisma CLI hangs in some environments (see tests/setup.ts), so this
 * script executes the migration SQL through the query engine itself, using
 * the same statement splitter as the test bootstrap.
 *
 * Usage:
 *   tsx scripts/apply-migration.ts 20261001200000_phase3_workspaces
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../packages/database/src/client.js";

const name = process.argv[2];
if (typeof name !== "string" || name.length === 0) {
  console.error("Usage: tsx scripts/apply-migration.ts <migration-dir>");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "database", "migrations", name, "migration.sql"), "utf8");

function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  for (const line of source.split("\n")) {
    current += `${line}\n`;
    const upper = line.trim().toUpperCase();
    if (/\bBEGIN\b/.test(upper) && !/^\s*--/.test(line)) depth += 1;
    if (/^END;?\s*$/.test(upper)) depth = Math.max(0, depth - 1);
    if (depth === 0 && /;\s*$/.test(line.trim()) && current.trim().length > 0) {
      const stmt = current.trim();
      if (!/^--\s*$/.test(stmt)) statements.push(stmt);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}

for (const stmt of splitStatements(sql)) {
  await prisma.$executeRawUnsafe(stmt);
}
console.log(`applied ${name}`);
await prisma.$disconnect();
