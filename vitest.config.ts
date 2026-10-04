import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Financial ledger + ledger-adjacent suites must not run concurrently
    // against the same SQLite file. A single fork worker with no file
    // parallelism keeps every suite serial in one process (vitest 5 replaced
    // the old poolOptions.forks.singleFork with maxWorkers + fileParallelism).
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["packages/*/src/**/*.ts", "apps/api/src/**/*.ts"],
      exclude: ["**/index.ts", "**/*.test.ts", "**/test-support/**"],
    },
  },
});