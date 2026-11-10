import { defineConfig } from "vitest/config";

// The testnet run in e2e/ pays real testnet USDC and runs only through `pnpm mcp:e2e`.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
