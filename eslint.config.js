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
    "**/cdk.out/",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // `<package>/testing` subpaths hold test helpers (e.g. `FakeRpc`); they must never reach
    // production code, by package subpath or by relative path.
    files: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@stellar-x402/*/testing", "**/testing", "**/testing.js"],
              message: "Test helpers are for tests only.",
            },
          ],
        },
      ],
      // `no-restricted-imports` doesn't see a dynamic `import()`.
      "no-restricted-syntax": [
        "error",
        {
          // esquery's regex can't hold a `/`, hence `\x2F`.
          selector: "ImportExpression[source.value=/(^|\\x2F)testing(\\.js)?$/]",
          message: "Test helpers are for tests only.",
        },
      ],
    },
  },
  {
    files: ["tools/scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    // Lambda handlers run as plain ES modules on the Node.js runtime (infra/, task 0027).
    files: ["infra/lambdas/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", AbortSignal: "readonly" },
    },
  },
  {
    files: ["conformance/external-proxy/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", fetch: "readonly" } },
  },
]);
