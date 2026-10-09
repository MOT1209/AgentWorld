/**
 * Guard against documentation drift.
 *
 * Counts the values that can be derived deterministically from the tree —
 * the number of registered tools, the number of Prisma models, the number of
 * AI vendor catalog entries, and the number of MCP tools/resources — and
 * asserts that README.md states them correctly. Test counts are intentionally
 * NOT checked here because they vary with environment-gated (skipped) suites.
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

function sectionOf(src: string, startMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start < 0) return "";
  const end = src.indexOf("];", start);
  if (end < 0) return src.slice(start);
  return src.slice(start, end);
}

function countVendors(): number {
  const src = readFileSync(join(root, "packages/ai/src/providers/catalog.ts"), "utf8");
  const section = sectionOf(src, "VENDOR_CATALOG");
  return [...section.matchAll(/vendorId:\s*"/g)].length;
}

function countMcpTools(): number {
  const src = readFileSync(join(root, "packages/mcp/src/server.ts"), "utf8");
  const section = sectionOf(src, "MCP_TOOLS");
  return [...section.matchAll(/name:\s*"/g)].length;
}

function countMcpResources(): number {
  const src = readFileSync(join(root, "packages/mcp/src/server.ts"), "utf8");
  const section = sectionOf(src, "MCP_RESOURCES");
  return [...section.matchAll(/uriPattern:/g)].length;
}

const tools = countTools();
const models = countModels();
const vendors = countVendors();
const mcpTools = countMcpTools();
const mcpResources = countMcpResources();
const readme = readFileSync(join(root, "README.md"), "utf8");

const problems: string[] = [];
if (!readme.includes(`${tools} tools`)) {
  problems.push(`README does not state "${tools} tools" (actual tool count in the registry).`);
}
if (!readme.includes(`${tools}-tool registry`)) {
  problems.push(`README does not state "${tools}-tool registry" (registry phrasing drifted).`);
}
if (!readme.includes(`${models} models`)) {
  problems.push(`README does not state "${models} models" (actual Prisma model count).`);
}
if (!readme.includes(`${vendors} vendors`) && !readme.includes(`${vendors}-vendor`)) {
  problems.push(`README does not state "${vendors} vendors" (actual vendor catalog count).`);
}
if (!readme.includes(`${mcpTools} tools`)) {
  problems.push(`README does not state "${mcpTools} tools" for MCP (actual MCP tool count).`);
}
if (!readme.includes(`${mcpResources} resources`)) {
  problems.push(`README does not state "${mcpResources} resources" for MCP (actual MCP resource count).`);
}

if (problems.length > 0) {
  console.error("Documentation drift detected:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  console.error(
    `\nTree: ${tools} tools, ${models} models, ${vendors} vendors, MCP ${mcpTools} tools/${mcpResources} resources. Update README.md to match.`,
  );
  process.exit(1);
}

process.stdout.write(
  `Doc counts OK: ${tools} tools, ${models} models, ${vendors} vendors, MCP ${mcpTools} tools/${mcpResources} resources match README.\n`,
);
