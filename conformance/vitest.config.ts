import { defineConfig } from "vitest/config";

// The upstream checkout under .cache/ holds its own test files.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
