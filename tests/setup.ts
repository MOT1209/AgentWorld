/**
 * Test database bootstrap — CLI-free.
 *
 * The `Transaction` immutability triggers make `deleteMany` impossible, so
 * every test run gets a FRESH database file recreated from the migration SQL.
 *
 * Why no `prisma migrate deploy`? The Prisma CLI hangs in this environment
 * (even `prisma --version` never returns), so the schema is applied by
 * executing the migration SQL through the query engine itself, which is
 * proven to work (seed + app run on it).
 */
import { readFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const databaseDir = join(root, "database");
const migrationsDir = join(databaseDir, "migrations");

function resolveTestDbUrl(): { url: string; filePath: string } {
  // An explicit TEST_DATABASE_URL is honored verbatim (e.g. CI pinning).
  // Otherwise each run gets a UNIQUE file so concurrent runs (two sessions,
  // watch mode + single run, sharded CI) can never share -- and corrupt --
  // each other's database.
  const explicit = (process.env.TEST_DATABASE_URL ?? "").trim();
  if (explicit !== "") {
    const match = /^file:(.+)$/.exec(explicit);
    const relative = (match?.[1] ?? "./test.db").replace(/^\.\//, "");
    const filePath = join(databaseDir, relative);
    return { url: `file:${filePath}`, filePath };
  }
  // Best-effort cleanup of stale run files; the live one is never ours.
  try {
    for (const entry of readdirSync(databaseDir)) {
      if (/^test-\d+-\d+\.db(-journal|-wal|-shm)?$/.test(entry)) {
        try {
          unlinkSync(join(databaseDir, entry));
        } catch {
          // Locked by a live run -- leave it alone.
        }
      }
    }
  } catch {
    // Database dir unreadable; creation below fails loudly.
  }
  const filePath = join(databaseDir, `test-${process.pid}-${Date.now()}.db`);
  return { url: `file:${filePath}`, filePath };
}

const { url, filePath } = resolveTestDbUrl();

process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const candidate = `${filePath}${suffix}`;
  try {
    if (existsSync(candidate)) unlinkSync(candidate);
  } catch {
    // Best effort; creation below will fail loudly if locked.
  }
}

/** Splits migration SQL into executable statements, keeping BEGIN...END trigger bodies intact. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  for (const line of sql.split("\n")) {
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

const migrationNames = readdirSync(migrationsDir)
  .filter((name) => !name.startsWith(".") && !name.endsWith(".toml"))
  .sort();

const db = new PrismaClient({ datasourceUrl: url });
try {
  await db.$connect();
  // Resilient to a leftover file another run could not delete (Windows locks).
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "transaction_is_immutable_update"`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "transaction_is_immutable_delete"`);
  for (const table of [
    // Phase 2 orchestration tables first: they reference Task/Agent/User.
    "DecisionConflict",
    "Escalation",
    "AgentHierarchy",
    "AgentSession",
    "Report",
    "TaskReview",
    "Plan",
    "ToolInvocation",
    "ActivityLog",
    "EventLog",
    "AgentBlueprint",
    "ApprovalRequest",
    "Transaction",
    "Wallet",
    "Message",
    "ConversationParticipant",
    "Conversation",
    "TaskDependency",
    "Task",
    "Project",
    "AgentRelationship",
    // Phase 1 simulation tables: they reference Agent and Location, so they
    // must be dropped before either.
    "AgentActivity",
    "AgentGoal",
    "AgentMemory",
    "AgentStateHistory",
    "AgentState",
    "Agent",
    "Location",
    "City",
    "World",
    "CompanyMember",
    "Department",
    "Company",
    "User",
  ]) {
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`);
  }
  for (const name of migrationNames) {
    let sql: string;
    try {
      sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    for (const stmt of splitStatements(sql)) {
      await db.$executeRawUnsafe(stmt);
    }
  }
} finally {
  await db.$disconnect();
}
