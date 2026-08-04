import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each test file builds real ts.Programs and spawns the server bin;
    // parallel workers contend badly on CI-sized machines.
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      // Ratchet the measured whole-src baseline. Raise these as coverage grows;
      // the long-term target remains 100% in every category.
      thresholds: {
        lines: 68,
        statements: 68,
        functions: 90,
        branches: 83,
      },
    },
  },
});
