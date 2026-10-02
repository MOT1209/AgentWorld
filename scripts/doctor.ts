/* eslint-disable no-console */
/**
 * Environment doctor. Checks everything `npm run verify` silently assumes
 * and tells you exactly what to fix. Exit 0 = healthy, 1 = something wrong.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
let failures = 0;

function ok(label: string): void {
  console.log(`ok   ${label}`);
}

function fail(label: string, hint: string): void {
  failures += 1;
  console.log(`FAIL ${label}\n       -> ${hint}`);
}

const major = Number(process.versions.node.split(".")[0] ?? 0);
if (major >= 20) ok(`node ${process.version} (>= 20)`);
else fail(`node ${process.version}`, "Install Node 20.11+ (22 recommended).");

const envPath = join(root, ".env");
if (existsSync(envPath)) ok(".env present");
else fail(".env missing", "Copy it: cp .env.example .env (works as-is for development).");

const examplePath = join(root, ".env.example");
if (existsSync(examplePath)) ok(".env.example present");
else fail(".env.example missing", "Restore it from git: git checkout -- .env.example.");

try {
  await import("@prisma/client");
  ok("@prisma/client resolves");
} catch {
  fail("@prisma/client missing", "Run: npm install && npm run db:generate.");
}

try {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  await db.$queryRawUnsafe("SELECT 1");
  await db.$disconnect();
  ok("database reachable (DATABASE_URL)");
} catch (error) {
  fail(
    "database unreachable",
    `Check DATABASE_URL in .env. Detail: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const secret = process.env.JWT_SECRET ?? "";
if (process.env.NODE_ENV === "production" && secret.length < 32) {
  fail("JWT_SECRET too weak for production", "Generate: openssl rand -hex 48.");
} else {
  ok("JWT_SECRET posture ok for current NODE_ENV");
}

const workspaceRoot = join(root, "workspaces");
try {
  const { mkdirSync, rmSync } = await import("node:fs");
  mkdirSync(workspaceRoot, { recursive: true });
  const probe = join(workspaceRoot, ".doctor-probe");
  rmSync(probe, { force: true });
  ok("workspace root writable");
} catch {
  fail("workspace root not writable", `Ensure the process can create ${workspaceRoot}.`);
}

if (failures > 0) {
  console.log(`\ndoctor: ${failures} problem(s) found.`);
  process.exit(1);
}
console.log("\ndoctor: all healthy.");
