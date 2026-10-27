import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// AW-33 (fourth pass): tests/setup.ts drops every table before replaying the
// migrations, for the case where a leftover test database could not be
// deleted (Windows locks). A table missing from that list makes the replay
// fail with "table already exists". CLAUDE.md asks for every new table to be
// added; this keeps the list honest.

const root = join(import.meta.dirname, "..");

describe("tests/setup.ts DROP list", () => {
  it("names every table the migrations create", () => {
    const migrationsDir = join(root, "database", "migrations");
    const created = new Set<string>();
    for (const name of readdirSync(migrationsDir)) {
      if (name.startsWith(".") || name.endsWith(".toml")) continue;
      const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
      for (const match of sql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)) {
        const table = match[1] as string;
        // new_* tables are SQLite's temporary copies during a column redefinition.
        if (!table.startsWith("new_")) created.add(table);
      }
    }
    const setup = readFileSync(join(root, "tests", "setup.ts"), "utf8");
    const missing = [...created].filter((table) => !setup.includes(`"${table}"`));
    expect(missing).toEqual([]);
  });
});
