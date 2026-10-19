import { defineConfig } from "vitest/config";

// The testnet run in e2e/ pays real testnet USDC and runs only through `pnpm e2e:testnet`.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
