import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The repo's lint rule that keeps `./testing` (`FakeRpc`) out of production code: it ships in
 * `dist`, so only lint stops `src` from importing it.
 */
const eslint = new ESLint({ cwd: fileURLToPath(new URL("../../..", import.meta.url)) });

/** The rule's messages for `code` linted as `filePath` (relative to the repo root). */
async function testingErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.message.includes("Test helpers are for tests only."))
    .map((message) => message.ruleId ?? "");
}

describe("test helpers stay out of production code", () => {
  it.each([
    ['import { FakeRpc } from "@stellar-x402/signer-pool/testing";', "apps/facilitator/src/a.ts"],
    ['export * from "./testing.js";', "packages/signer-pool/src/index.ts"],
    ['import { FakeRpc } from "../testing";', "packages/signer-pool/src/rpc/a.ts"],
    ['await import("@stellar-x402/signer-pool/testing");', "apps/facilitator/src/a.ts"],
    ['await import("./testing.js");', "packages/signer-pool/src/a.ts"],
  ])("refuses %s in %s", async (code, filePath) => {
    expect(await testingErrors(code, filePath)).toHaveLength(1);
  });

  it.each([
    ['import { FakeRpc } from "@stellar-x402/signer-pool/testing";', "apps/facilitator/test/a.ts"],
    ['export { FakeRpc } from "../test/fake-rpc.js";', "packages/signer-pool/src/testing.ts"],
    ['import { pool } from "./testing-pool.js";', "packages/signer-pool/src/a.ts"],
  ])("allows %s in %s", async (code, filePath) => {
    expect(await testingErrors(code, filePath)).toEqual([]);
  });
});
