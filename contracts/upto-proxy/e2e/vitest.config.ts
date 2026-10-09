import { defineConfig } from "vitest/config";

// Every test talks to testnet: allow for ledger closes (~5 s) and friendbot, and run in order.
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
