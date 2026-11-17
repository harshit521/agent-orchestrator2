import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Several suites create real Git worktrees in the same repository, so
    // running test files in parallel makes them contend on Git locks.
    fileParallelism: false,
  },
});
