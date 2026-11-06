// Bundles the off-server check into one ES module for `Code.fromAsset` (0027, #115): the handler,
// signer-pool's balance check and stellar-sdk. Run by `build`, after tsc, so synth stays offline
// and never bundles, as the uptime probe's plain modules don't. `@aws-sdk/*` comes with the
// Lambda runtime. The bundle calls no `require`, so it needs no `createRequire` banner;
// test/watch-bundle.test.ts loads it in plain Node to keep that true.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
const outdir = join(root, "dist", "lambdas", "watch");

rmSync(outdir, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ["lambdas/watch/index.mjs"],
  outfile: join(outdir, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["@aws-sdk/*"],
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
