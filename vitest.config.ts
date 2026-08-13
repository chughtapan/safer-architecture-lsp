import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each test file builds real ts.Programs and spawns the server bin;
    // parallel workers contend badly on CI-sized machines.
    fileParallelism: false,
    testTimeout: 30_000,
    // Coverage is measured by c8 (`npm run test:coverage`), not by this
    // provider. The server, proxy, and CLI suites exercise their code by
    // spawning the built `dist/` bins, and an in-process v8 provider cannot
    // instrument a child process. c8 sets NODE_V8_COVERAGE so every spawned
    // process reports, and remaps through sourcemaps back to src.
    // The ratchet lives in .c8rc.json.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
