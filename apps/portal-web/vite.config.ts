import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { BASE_PATH } from "./src/base-path.ts";

export default defineConfig({
  base: BASE_PATH,
  plugins: [react()],
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "jsdom" },
});
