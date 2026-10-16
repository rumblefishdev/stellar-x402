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
    // `<package>/testing` subpaths hold test helpers (e.g. `FakeRpc`); they ship in `dist` but
    // must never reach production code.
    files: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
    ignores: ["packages/*/src/testing.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@stellar-x402/*/testing"],
              message: "Test helpers are for tests only.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["tools/scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    files: ["conformance/external-proxy/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", fetch: "readonly" } },
  },
]);
