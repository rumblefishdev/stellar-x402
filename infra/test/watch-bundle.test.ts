// The Lambda's bundle as it ships (dist/lambdas/watch/index.mjs, from `build`): loaded by a plain
// Node process, as the runtime does, with a stub for the AWS SDK the runtime provides. It catches
// what the source tests can't: a bundle that throws at import (a CommonJS `require` with no
// banner), an entry that exports no handler, or one that never reaches the RPC.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { WATCH_BUNDLE_DIR } from "../src/lib/stacks/watch-stack.js";

const BUNDLE = join(WATCH_BUNDLE_DIR, "index.mjs");
const dir = mkdtempSync(join(tmpdir(), "x402-watch-bundle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for `@aws-sdk/client-cloudwatch` that records what the handler sends. */
function stubSdk(): void {
  const pkg = join(dir, "node_modules", "@aws-sdk", "client-cloudwatch");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@aws-sdk/client-cloudwatch", type: "module", main: "index.mjs" }),
  );
  writeFileSync(
    join(pkg, "index.mjs"),
    [
      "export const sent = [];",
      "export class CloudWatchClient { async send(c) { sent.push(c.input); return {}; } }",
      "export class PutMetricDataCommand { constructor(input) { this.input = input; } }",
    ].join("\n"),
  );
}

/** Runs `script` in a fresh Node process beside the copied bundle; prints JSON on stdout. */
function node(script: string, env: Record<string, string>): unknown {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

describe("the watch bundle", () => {
  test("exists: infra's tests run after its build", () => {
    expect(existsSync(BUNDLE), `${BUNDLE}: run pnpm build in infra/`).toBe(true);
  });

  test("loads in plain Node, exports a handler, and reaches the RPC it is given", () => {
    copyFileSync(BUNDLE, join(dir, "index.mjs"));
    stubSdk();
    const result = node(
      `
      const { handler } = await import("./index.mjs");
      const { sent } = await import("@aws-sdk/client-cloudwatch");
      let error = null;
      try { await handler({ scheduledTime: "2026-11-06T09:40:00Z" }); }
      catch (e) { error = String(e && e.message); }
      console.log(JSON.stringify({ handler: typeof handler, error, sent: sent.length }));
      `,
      {
        // A closed port: the read fails at once, so the run throws and publishes nothing.
        WATCH_TARGETS: JSON.stringify([
          {
            network: "stellar:testnet",
            feeAccount: "GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP",
            rpcUrl: "https://127.0.0.1:1",
          },
        ]),
      },
    );
    expect(result).toEqual({
      handler: "function",
      error: expect.stringMatching(/^balance not read on stellar:testnet/),
      sent: 0,
    });
  });
});
