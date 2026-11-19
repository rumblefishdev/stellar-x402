import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const zodMajor = (from: string | URL) =>
  (
    JSON.parse(readFileSync(createRequire(from).resolve("zod/package.json"), "utf8")) as {
      version: string;
    }
  ).version.split(".")[0];

// `service-metadata.ts` extends `@x402/core`'s schemas with this package's zod. With a field of
// another major every parse throws `expected a Zod schema`, and `/verify` and `/settle` answer
// 500 (0145). That error doesn't name its cause; this one does.
it("has the zod major @x402/core builds its schemas with", () => {
  const core = realpathSync(new URL("../node_modules/@x402/core/package.json", import.meta.url));
  expect(
    zodMajor(import.meta.url),
    "packages/bazaar's zod must be the major of @x402/core's zod: its schemas extend upstream's",
  ).toBe(zodMajor(core));
});
