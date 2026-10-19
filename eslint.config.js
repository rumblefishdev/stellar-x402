import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/dist/",
    "**/node_modules/",
    "**/.turbo/",
    "**/coverage/",
    "contracts/target/",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["tools/scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    files: ["conformance/external-proxy/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", fetch: "readonly" } },
  },
]);
