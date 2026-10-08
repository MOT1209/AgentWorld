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
    // Load-sensitive wait-loop tests (queue runner, REST execution streams)
    // flake on slower machines when the whole suite shares one fork: each
    // 30s+ failure observed was a waitFor timeout under load, not a logic
    // regression. A generous ceiling keeps the wait loops meaningful (they
    // still fail on real hangs) without punishing loaded environments.
    testTimeout: 120_000,
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