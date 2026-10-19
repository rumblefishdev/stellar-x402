---
id: "0028"
title: "Gate harness: external proxy and runner"
type: FEATURE
status: active
milestone: 1
related_adr: ["0009"]
related_tasks: ["0012", "0029", "0032"]
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
- **Silent passes.** A typo in `--facilitators` or zero scenarios exits 0 with no JSON (`e2e/test.ts:840,918`); the fetch client reports success with an empty `transaction` when the payment response header is missing (`e2e/clients/typescript/http/fetch/index.ts:25`). The JSON carries no upstream commit.
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
- 2026-10-15 — **Dry-run evidence** (x402.org) goes into this task and the PR, not `conformance/results/`, which holds our facilitator's runs (0029).

## Not yet decided

- None.

## Out of scope

- The bazaar discovery check (`--extensions=bazaar`): once `/discovery/search` exists.
- Running the gate in CI.

## Acceptance Criteria

- [ ] Given `conformance/external-proxy/`, when it is built, then it has a `test.config.json` (`name`, `type: facilitator`, `language: typescript`, `protocolFamilies: [stellar]`, `schemes: [exact]`, `x402Versions: [2]`, `extensions: [bazaar]`, and `environment.required` naming our facilitator-URL variable) and a `run.sh` that listens on `PORT`, prints `Facilitator listening`, answers `GET /health` and `POST /close`, and forwards `/verify`, `/settle` and `/supported`
- [ ] Given a conformance script, when it runs, then it clones `x402-foundation/x402` read-only at a pinned commit, copies in only our proxy folder and runs the full Stellar `exact` matrix with `--output-json`; nothing else in the clone is changed and nothing is pushed upstream
- [ ] Given a run with no JSON, zero scenarios, a failed scenario or a passed one without a transaction hash, when the script finishes, then it exits non-zero and says which
- [ ] Given the proxy pointed at the public Stellar facilitator, when the harness runs, then it completes end to end, which proves the harness before our facilitator is ready
- [x] Given the `/exact/stellar/upfront` scenario, when this story is done, then what it requires from a Stellar facilitator is answered and written down (see `upfront` above; the spine's open question is closed in the PR)
