---
id: "0028"
title: "Gate harness: external proxy and runner"
type: FEATURE
status: completed
milestone: 1
related_adr: ["0009"]
related_tasks: ["0012", "0029", "0032", "0059"]
tags: [conformance, e2e, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 3.1 (Platform lane)."
  - date: "2026-10-15"
    status: active
    who: karolkow
    note: >
      Started after a recon of the upstream harness at 10b2d06 and a grilling round: full Stellar
      matrix instead of --min, bazaar declared but not checked in T1, local script only.
  - date: "2026-10-23"
    status: completed
    who: karolkow
    note: >
      PR #47 merged 2026-10-20. `pnpm conformance:e2e` runs the unmodified x402 e2e suite at
      10b2d06 against any facilitator URL through an external proxy, judges the suite's JSON and
      checks every hash on chain. 32 unit tests; gate passed 18 of 18 on the final code (Vellar).
      Follow-ups in 0059.
---

# Gate harness: external proxy and runner

## Summary

As a reviewer of the grant, I want a reproducible way to run the unmodified x402 e2e suite against our facilitator, so that conformance is shown by evidence, not claimed.

**Story:** [M1 Story 3.1](../../../docs/planning/m1-epics.md#story-31-gate-harness-external-proxy-and-runner) · **Lane:** Platform · **Covers:** FR21 (AD-15)

## Context

- Upstream harness at x402-foundation/x402 `10b2d06`: external proxies live under `e2e/facilitators/external-proxies/` (git-ignored, no upstream example).
- No dependency on `/settle`, so this runs in week 1 alongside the skeleton.

### Recon (2026-10-15)

Read in a clone of upstream; paths are upstream's.

- **Pin.** `10b2d06..e95b0666` (9 commits) changes nothing in `e2e/` or `typescript/packages/mechanisms/stellar` (measured: `git diff --stat`). `@x402/core` there is 2.28.0, our AD-14 pin.
- **Discovery.** `--facilitators=X` matches the proxy's directory name (`e2e/src/cli/filters.ts:99`); the bazaar check looks the facilitator up by `config.name` (`e2e/extensions/bazaar.ts:570`). `language: typescript` is load-bearing: the Stellar routes list `sdks: ["typescript"]`. A config without `extensions` gets `["bazaar"]` (`e2e/src/mechanisms.ts:733`).
- **Lifecycle.** The harness runs `bash run.sh` in the proxy directory, waits for `Facilitator listening` on stdout (30 s), polls `GET /health` for a 200 JSON body, stops with `POST /close`, then SIGTERM to the bash PID (`e2e/src/proxy-base.ts`, `e2e/src/facilitators/generic-facilitator.ts`). The harness itself never calls `/verify`, `/settle` or `/supported`; the canonical server does, at `http://localhost:<PORT>`.
- **Env.** The harness refuses to start without `SERVER_STELLAR_ADDRESS`, `CLIENT_STELLAR_PRIVATE_KEY` and `FACILITATOR_STELLAR_PRIVATE_KEY`, the last even for an external facilitator (`e2e/test.ts:946-958`). The client needs testnet USDC, the server a USDC trustline; nothing in the suite funds them.
- **`/supported`.** It must list `exact` on `stellar:testnet` with `extra.areFeesSponsored: true`; the canonical client throws otherwise (`stellar/src/exact/client/scheme.ts:58`).
- **Silent passes.** A typo in `--facilitators` or zero scenarios exits 0 with no JSON (`e2e/test.ts:840,918`); the axios client reports success with an empty `transaction` when the payment response header is missing (`e2e/clients/typescript/http/axios/index.ts:24`; the fetch client throws instead, `core/src/http/x402HTTPClient.ts:159`). The JSON carries no upstream commit.
- **Prerequisites.** `pnpm install` and build in `typescript/`, then `e2e/setup.sh` (`.github/workflows/e2e_tests.yml:155-168`).
- **Public facilitator for the dry run.** `https://x402.org/facilitator/supported` lists `exact` on `stellar:testnet` with fees sponsored, no `bazaar` (measured 2026-10-15). Fallback: Vellar (community, 60 req/min).

### `upfront` (acceptance criterion 4)

`paymentFlow: "upfront"` skips `/verify` and calls `/settle` before the route handler; a failed settle returns 402 and the handler never runs (`typescript/packages/core/src/server/paymentFlow.ts:19-27`, `x402HTTPResourceServer.ts:697-709`). `paymentRequirements.extra.paymentFlow` is `"upfront"` on that `/settle`. The Stellar client and facilitator schemes have no flow-specific code. So a Stellar facilitator must settle a payment it never verified: ours checks the payment inside `/settle` itself (0009, `settle.ts` `deps.check`), so a plain forward is enough. Any later gate that requires a prior `/verify` must skip `upfront`.

## Implementation

- Proxy folder with config and forwarding script.
- Runner script with the pinned upstream commit.
- Dry run against the public facilitator; record the `upfront` answer in this task and the spine's open questions.

## Decisions so far

- 2026-10-15 — **Full Stellar matrix, no `--min`**: every canonical TypeScript client and server, HTTP and MCP, both routes (~18 payments of 0.001 testnet USDC, derived). Changes ADR 0009's runner command.
- 2026-10-15 — **Bazaar declared, not checked in T1**: `extensions: ["bazaar"]` in the config; the runner runs without `--extensions=bazaar`, because the suite's check also needs `/discovery/search`, which 0032 leaves to a later tranche. Note added to 0032.
- 2026-10-15 — **Local script only**; a CI workflow with a testnet key in secrets is a later, separate decision.
- 2026-10-15 — **Pin stays `10b2d06`** (no relevant diff to HEAD).
- 2026-10-15 — **Proxy on Node built-ins** (`node:http`, `fetch`), `run.sh` does `exec node proxy.mjs`: only this folder is copied into the clone, so it has no dependencies, and `exec` lets the harness's SIGTERM reach node.
- 2026-10-15 — **Runner in TypeScript** in `conformance/`, run with `tsx`. It fails on: no JSON, zero scenarios, any failed scenario, any passed scenario without a transaction hash. It adds the upstream commit, date and target URL to the saved JSON.
- 2026-10-15 — **Keys** from an env file outside the repo, the same accounts as the MCP e2e suite; `FACILITATOR_STELLAR_PRIVATE_KEY` gets a placeholder the proxy ignores.
- 2026-10-15 — **Names**: directory and `config.name` `stellar-x402`, URL variable `GATE_FACILITATOR_URL`, root command `pnpm conformance:e2e`.
- 2026-10-16 — **Every run builds the suite from a fresh clone** (+2.5 min): the clean check sees only tracked files, so a build kept from an earlier run would not be covered by it.
- 2026-10-16 — **The gate reads every hash on chain** through Stellar RPC `getTransaction` (Horizon is deprecated in favour of RPC): it fails unless each is a successful single `transfer` of 10000 units of testnet USDC from the buyer to the seller.
- 2026-10-19 — **A hash proves this run through this facilitator**: the gate fails when two scenarios report one hash, when a transaction was made before the run started, or when its fee was paid by an account the facilitator does not list as a Stellar signer in `/supported` (read before any payment). Each transaction's ledger, time, fee payer and call are saved with the run.
- 2026-10-19 — **A hash RPC cannot answer for is a problem of the run**, not a crash: the run is saved, unless the gate is interrupted.
- 2026-10-19 — **The placeholder package files go in this PR** (`src/index.ts`, its build config, the unused `@stellar-x402/config`): the package existed for this task to fill; named in the PR body.
- 2026-10-20 — **The suite's raw result is kept apart**: each run saves a folder with the suite's own JSON copied byte for byte (`suite.json`) and the gate's verdict (`gate.json`), which names that file and its SHA-256.
- 2026-10-15 — **Dry-run evidence** (x402.org) goes into this task and the PR, not `conformance/results/`, which holds our facilitator's runs (0029).

### Emerged

- 2026-10-15 — **Upstream's `setup.sh` is not run**: it also builds the Go and Python components
  and fails without a Go toolchain. The runner runs the TypeScript components' own `install.sh`
  and `build.sh`, after `pnpm install` + `pnpm build` in `typescript/` and `pnpm install` in `e2e/`,
  as upstream's CI does.
- 2026-10-19 — **The checkout lives in a temporary folder** made for each run and deleted when the gate exits (it held 6.1 GB and nothing read it after a run).
- 2026-10-15 — **The checkout lived** in `conformance/.cache/x402/` (git-ignored,
  6.1 GB measured) and is rebuilt on every run (decided 2026-10-16); after the build and the proxy
  copy, the run checks that HEAD is the pin and no tracked file changed.
- 2026-10-15 — **`--schemes=exact`** is passed although Stellar has only `exact` routes today, so a
  pin bump that adds a Stellar `upto` route does not widen the gate silently.
- 2026-10-15 — **The proxy passes the facilitator's status and content type through** and answers
  502 when it cannot reach it; anything but the three forwarded routes and `/health`, `/close` is a
  404.
- 2026-10-15 — **The conformance package has no build**: the placeholder `src/index.ts`, its build
  config and the unused `@stellar-x402/config` dependency went; it runs with `tsx` like the e2e
  packages.

- 2026-10-15 — **After a security review**: the proxy listens on `localhost` only, and the gate
  fails on any suite exit but 0, even when the file says every scenario passed. A second dry run
  passed 18 of 18 with both (all hashes successful on Horizon).

## Dry run (2026-10-15)

`GATE_FACILITATOR_URL=https://x402.org/facilitator pnpm conformance:e2e`: 18 of 18 scenarios
passed in 4.6 minutes (`passed: true`, `problems: []`), 9 `authorization` and 9 `upfront`. All 18
hashes are successful on Horizon, each submitted by `GC6CSXBV…` with fees paid by `GC5OLUZ4…`, the
two signers x402.org lists in `/supported`, so every payment went through the proxy.

| #   | transport | client | server  | flow          | transaction |
| --- | --------- | ------ | ------- | ------------- | ----------- |
| 1 | http | axios | express | authorization | `134fae156e84fd1c87e3dd3d666fa5c1779eb8b58a0c553632cf3cf7507f2ae9` |
| 2 | http | axios | express | upfront | `94eb7d3da589267c98122df209cc3335284adaf82bb78ce5efd7e18826cf0ec8` |
| 3 | http | fetch | express | authorization | `71bb13810b1c21eb25c913e4234de49a716c0b32e5dde29f9b6040adf1d4f4fc` |
| 4 | http | fetch | express | upfront | `51b706b491a3f8e37b86b2d3393de494348ffd6a65f12757d67d33c2a17c5ed2` |
| 5 | http | axios | fastify | authorization | `dbacf70213a08ca0f7eb8b084375919dc1e5c1154263852f8d5dfb2bef5947da` |
| 6 | http | axios | fastify | upfront | `9a9be84609f2e6854ad66b37dfb3e4419d77c4853d251621e32c6a798413bd72` |
| 7 | http | fetch | fastify | authorization | `79792d5384e62df25b310f3a407761ca0c15b8fb4c15d966c442ab51628600ad` |
| 8 | http | fetch | fastify | upfront | `8ec51a9e3234319421d7872acd2d90e2565f3106f013a7d950450057f857d450` |
| 9 | http | axios | hono | authorization | `02e9882a8e861e6801f1149fb3c7291f6c8c104959f143e1a7da0c39472b1f33` |
| 10 | http | axios | hono | upfront | `8d3775fd8d74ae899d6c04b5908963e36947f69d8dd5e3a5f4df44b16259e834` |
| 11 | http | fetch | hono | authorization | `703461290a65dd09115fb74a7bb6a4d30cec36720126da533cb9a589c54df27d` |
| 12 | http | fetch | hono | upfront | `340ce04d89377f167334cf7394fac64f2d1ef73bcdb569f3067ef40c255860cb` |
| 13 | http | axios | next | authorization | `4428584b83dc941471be870c51bddb788ce3b4e54e0dd07f613dc2ba43b9d52d` |
| 14 | http | axios | next | upfront | `082fbfbe6b920567470ef7f54b54ca65513454be1586ec373c941324ff8fd332` |
| 15 | http | fetch | next | authorization | `3a69938dbd585a5597c71aea6c7c7c6d65bc1e81f779916e0e6ef8a2e25870ba` |
| 16 | http | fetch | next | upfront | `7a81f23e387b636231f86a4d0feb37ca513912e2110a962905c8d9e6ce4f0237` |
| 17 | mcp | mcp | mcp | authorization | `8273a3a285db935777fef125dbe680fd0201f66bd692a1ed041819283ed446e4` |
| 18 | mcp | mcp | mcp | upfront | `261eb69c02b8707f1ce4a98db8c496caf09bb61d1637d4112ac5f5777f7024d4` |

## Gate run on the final code (2026-10-19)

`GATE_FACILITATOR_URL=https://vellar-facilitator-testnet-production.up.railway.app pnpm conformance:e2e`
on commit `474d5b2` (the last runtime change): `Gate passed`, 18 of 18 in 6.4 minutes, `Read 18
transactions on chain`, 18 distinct hashes, every fee paid by `GDKU24JT…`, one of the six Stellar
signers Vellar lists in `/supported`, every transaction made after the run started. The same code
against x402.org passed 15 of 18 that morning: its `/settle` failed three payments, and all 15
reported hashes passed the new checks. Vellar is a community testnet facilitator; the run proves the
harness, not Vellar.

| #   | transport | client | server  | flow          | transaction |
| --- | --------- | ------ | ------- | ------------- | ----------- |
| 1 | http | axios | express | authorization | `215cc6ee245429a885f426009622e4446e438941ea5c38ec91cd91c49783cd05` |
| 2 | http | axios | express | upfront | `bce4d93273c89f6566211a4b4472b46ec427595bed2e14c23914892fc81a0db2` |
| 3 | http | fetch | express | authorization | `a234c7791e54c0cf0ef31f60ad56d8f52f9e0a101b1581f91d12f97df950de37` |
| 4 | http | fetch | express | upfront | `7d0ca073db513d6eb125922ef3261c51639d160edf88e0bd84eda9db93d28a84` |
| 5 | http | axios | fastify | authorization | `e67baf3ff69614da8a8934f307db52a306818af897f6f3c82045ba752cb26d3a` |
| 6 | http | axios | fastify | upfront | `135fc24e78811a2e57453c654b287e3cc3386684d97ae5f0ebcca917d4df2db9` |
| 7 | http | fetch | fastify | authorization | `1dd98e8a544481f0d75385349f0e9f31bbe53ee4b8c45924be0bdaf8b15df5ad` |
| 8 | http | fetch | fastify | upfront | `7dd5fc02fddb699fca8d2b4eb9ba9e68b399a8f816e4981ea291455c081f3dd5` |
| 9 | http | axios | hono | authorization | `2f8716ead19c22c33554fdf04ce45298f79c583a9b55c7cd6d631f707735833c` |
| 10 | http | axios | hono | upfront | `380f8a26dbe2c11951789a47c3546413fefd7b292a15df332913e9e2b9a32f71` |
| 11 | http | fetch | hono | authorization | `8e3bf64446bce803711e0c1adc7690a3bbd404bfc6e79ab795a5128c0df36f71` |
| 12 | http | fetch | hono | upfront | `920753d771e163cb427398e285d435ff4dec3fa549ff9732cd9fd209b7776366` |
| 13 | http | axios | next | authorization | `a859d511f0eafd2fee541fbf6cddbbf0e5ecd11974ec79178d79f6371636e56c` |
| 14 | http | axios | next | upfront | `15fcb056a3d41ebe705b6a0b17f8d72e967590d9a45492819f018331c835b806` |
| 15 | http | fetch | next | authorization | `4f94f08a99a4237519f97545c09198100056f61578adee73c6d8a2f5b00a949c` |
| 16 | http | fetch | next | upfront | `63c779a2b09f6d4e4ec9ae54b263975c5ed1600da18e70ae6dec215ba6e3ef23` |
| 17 | mcp | mcp | mcp | authorization | `53809c8792cfc9c5088fbd05445fb4e8a724ce8784a8de0ae8777612f0086fb1` |
| 18 | mcp | mcp | mcp | upfront | `370b2556a13f5b00c63f6aa48f73c3ba04d1a0a7dc376e177a493bfa22697c3d` |

## Issues Encountered

- **x402.org's `/settle` is unreliable**: on 2026-10-16 and 2026-10-19 it answered a Cloudflare 504
  page or "Settlement failed" for 14 of 108 payments, and most of those payments landed on chain
  anyway. The gate failed those runs, as it should; the final run used Vellar.
- **StrykerJS 10 ran 0 tests per mutant** under vitest 5, so mutants were hand-written (30 of 30
  killed before the review fixes).
- **A port flake** after binding the proxy to `localhost` (IPv6 first on macOS): the proxy test
  picked a free port on 127.0.0.1; fixed by picking it on the proxy's own host.

## Future Work

- 0059: keep the suite's raw JSON apart from the gate's verdict (a ready commit is on the local
  branch `lore-0028-raw-suite-result`), handle SIGTERM/SIGHUP so the ~6 GB checkout never stays
  behind, and check "made in this run" by ledger sequence instead of the local clock.
- 0029: decide whether to bump the pin before the run of record (upstream's Stellar mechanism
  changed after 10b2d06).

## Not yet decided

- None.

## Out of scope

- The bazaar discovery check (`--extensions=bazaar`): once `/discovery/search` exists.
- Running the gate in CI.
- Finding the payment behind a failed scenario: all payments carry the same amount, so a match by time is a guess, and a failed scenario already fails the gate. A public facilitator's `/settle` answered 504 four times on 2026-10-16 while each payment landed; that is found by hand.

## Acceptance Criteria

- [x] Given `conformance/external-proxy/`, when it is built, then it has a `test.config.json` (`name`, `type: facilitator`, `language: typescript`, `protocolFamilies: [stellar]`, `schemes: [exact]`, `x402Versions: [2]`, `extensions: [bazaar]`, and `environment.required` naming our facilitator-URL variable) and a `run.sh` that listens on `PORT`, prints `Facilitator listening`, answers `GET /health` and `POST /close`, and forwards `/verify`, `/settle` and `/supported`
- [x] Given a conformance script, when it runs, then it clones `x402-foundation/x402` read-only at a pinned commit, copies in only our proxy folder and runs the full Stellar `exact` matrix with `--output-json`; nothing else in the clone is changed and nothing is pushed upstream
- [x] Given a run with no JSON, zero scenarios, a failed scenario or a passed one without a transaction hash, when the script finishes, then it exits non-zero and says which
- [x] Given the proxy pointed at the public Stellar facilitator, when the harness runs, then it completes end to end, which proves the harness before our facilitator is ready
- [x] Given the `/exact/stellar/upfront` scenario, when this story is done, then what it requires from a Stellar facilitator is answered and written down (see `upfront` above; the spine's open question is closed in the PR)
