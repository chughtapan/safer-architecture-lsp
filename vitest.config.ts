import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each test file builds real ts.Programs and spawns the server bin;
    // parallel workers contend badly on CI-sized machines.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
