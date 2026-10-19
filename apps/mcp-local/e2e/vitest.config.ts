import { defineConfig } from "vitest/config";

// Scenarios start real server processes and wait for testnet settlements (~5 s a ledger): run them
// in order, with room for a payment.
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
