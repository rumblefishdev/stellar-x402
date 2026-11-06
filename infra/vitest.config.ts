import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A full CDK synth runs in several tests; the explorer measured one over vitest's 5 s default
    // on a CI runner (its infra/vitest.config.ts).
    testTimeout: 30_000,
    // One worker that loads aws-cdk-lib once. Most of these tests' time is that import, and a
    // worker per file did it 6 times at once, starving the packages tested beside it in the same
    // turbo run: on #114's first CI run signer-pool's cold ESLint test went from 1.2 s to 6.1 s,
    // past its 5 s timeout. The files share no state: each builds its own App.
    fileParallelism: false,
    isolate: false,
  },
});
