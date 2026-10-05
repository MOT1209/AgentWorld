/**
 * Guard against documentation drift.
 *
 * Counts the two values that can be derived deterministically from the tree —
 * the number of registered tools and the number of Prisma models — and asserts
 * that README.md states them correctly. Test counts are intentionally NOT
 * checked here because they vary with environment-gated (skipped) suites.
 *
 * Run with: npm run check:docs
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function countTools(): number {
  const dir = join(root, "packages/tools/src/definitions");
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(/name:\s*"([a-z_]+\.[a-z_]+)"/g)) {
      names.add(m[1]);
    }
  }
  return names.size;
}

function countModels(): number {
  const schema = readFileSync(join(root, "database/schema.prisma"), "utf8");
  return (schema.match(/^model\s+\w+\s*\{/gm) ?? []).length;
}

const tools = countTools();
const models = countModels();
const readme = readFileSync(join(root, "README.md"), "utf8");

const problems: string[] = [];
if (!readme.includes(`${tools} tools`)) {
  problems.push(`README does not state "${tools} tools" (actual tool count in the registry).`);
}
if (!readme.includes(`${models} models`)) {
  problems.push(`README does not state "${models} models" (actual Prisma model count).`);
}

if (problems.length > 0) {
  console.error("Documentation drift detected:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  console.error(`\nTree: ${tools} tools, ${models} models. Update README.md to match.`);
  process.exit(1);
}

process.stdout.write(`Doc counts OK: ${tools} tools, ${models} models match README.\n`);
