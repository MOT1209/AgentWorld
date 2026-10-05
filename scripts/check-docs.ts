/**
 * Docs consistency check (`npm run check:docs`).
 *
 * README.md carries one machine-checked marker:
 *
 *   <!-- check-docs: models=38 tools=55 packages=19 -->
 *
 * The numbers must match the code: Prisma model count, registered built-in
 * tools, and `packages/*` directories. Doc prose may round; the marker may
 * not drift. Also fails if a documented file is missing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_TOOLS } from "../packages/tools/src/index.js";

const root = process.cwd();
const problems: string[] = [];

const schema = readFileSync(join(root, "database", "schema.prisma"), "utf8");
const actual = {
  models: (schema.match(/^model\s+\w+\s*\{/gm) ?? []).length,
  tools: BUILT_IN_TOOLS.length,
  packages: readdirSync(join(root, "packages")).filter((name) => statSync(join(root, "packages", name)).isDirectory()).length,
};

const readme = readFileSync(join(root, "README.md"), "utf8");
const marker = /<!--\s*check-docs:\s*models=(\d+)\s+tools=(\d+)\s+packages=(\d+)\s*-->/.exec(readme);
if (marker === null) {
  problems.push("README.md is missing the `<!-- check-docs: models=N tools=N packages=N -->` marker");
} else {
  const documented = { models: Number(marker[1]), tools: Number(marker[2]), packages: Number(marker[3]) };
  for (const key of ["models", "tools", "packages"] as const) {
    if (documented[key] !== actual[key]) {
      problems.push(`README marker says ${key}=${documented[key]} but the code has ${actual[key]}`);
    }
  }
}

for (const file of [
  "docs/ROADMAP.md",
  "docs/ARCHITECTURE.md",
  "docs/API.md",
  "docs/SECURITY.md",
  "docs/AGENTWORLD_PHASE_3_ARCHITECTURE.md",
  "docs/PHASE3-AUDIT.md",
  "plan.md",
]) {
  if (!existsSync(join(root, file))) problems.push(`Missing documented file: ${file}`);
}

if (problems.length > 0) {
  console.error(`check:docs found ${problems.length} problem(s):`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
process.stdout.write(`check:docs OK (models=${actual.models}, tools=${actual.tools}, packages=${actual.packages})
`);
