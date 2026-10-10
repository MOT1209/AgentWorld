/**
 * Removes the throwaway databases the test suite leaves behind.
 *
 * `tests/setup.ts` creates one file per worker — `database/test-<pid>-<token>.db`
 * — and nothing deletes it, so a long-lived checkout accumulates hundreds of
 * files and hundreds of megabytes. This only touches files matching that exact
 * pattern: `dev.db` and any explicit `TEST_DATABASE_URL` target are left alone.
 *
 * Run with: npm run db:clean:test
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const databaseDir = join(root, "database");
const TEST_DB = /^test-\d+-[a-z0-9-]+\.db(-journal|-wal|-shm)?$/i;

let removed = 0;
let bytes = 0;
let skipped = 0;

for (const file of readdirSync(databaseDir)) {
  if (!TEST_DB.test(file)) continue;
  const path = join(databaseDir, file);
  try {
    const size = statSync(path).size;
    rmSync(path, { force: true });
    bytes += size;
    removed += 1;
  } catch {
    // A database still held open by a running test is skipped, never reported
    // as cleaned.
    skipped += 1;
  }
}

process.stdout.write(
  `Removed ${removed} test database(s), ${(bytes / 1024 / 1024).toFixed(1)} MB freed` +
    (skipped > 0 ? `; ${skipped} still in use and left alone.\n` : ".\n"),
);
