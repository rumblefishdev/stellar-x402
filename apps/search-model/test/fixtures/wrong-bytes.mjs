// Preloaded into scripts/fetch-model.mjs by fetch-model.test.ts: every fetch answers bytes that
// are not the model's, so no network is reached. The script's `../dist/model.js` is read from
// the source, so the test needs no build.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../dist/model.js") return next("../src/model.ts", context);
    return next(specifier, context);
  },
});

globalThis.fetch = async () => new globalThis.Response("not the model's bytes");
