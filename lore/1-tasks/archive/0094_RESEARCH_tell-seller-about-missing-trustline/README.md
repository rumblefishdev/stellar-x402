---
id: "0094"
title: "Find how a seller can learn that their payTo has no trustline"
type: RESEARCH
status: completed
owner: akot
milestone: 2
related_adr: []
related_tasks: ["0078", "0092", "0102", "0107", "0075", "0164"]
tags: [facilitator, payments, priority-low, effort-small]
links:
  - ../../archive/0078_FEATURE_missing-trustline-reason.md
  - ../../archive/0092_FEATURE_sdk-missing-trustline-step.md
  - ../../archive/0102_FEATURE_sdk-helpers-from-the-rfp/README.md
  - notes/R-what-the-seller-sees.md
  - notes/R-prior-art.md
  - notes/S-recommendation.md
  - ../../../../apps/facilitator/test/live/payto-trustline-missing.ts
history:
  - date: "2026-11-02"
    status: backlog
    who: okarcz
    note: >
      Spawned from a check of 0078 and 0092: neither tells the seller, so a seller who offers an
      asset without a trustline doesn't learn it from us.
  - date: "2026-11-26"
    status: active
    who: akot
    note: >
      Started. Since it was written, 0092 closed and 0102 added `checkTrustline` to
      `@stellar-x402/sdk/seller`, which `examples/http-api` runs at start; the pin is `~2.31.0`, not
      `~2.28.0`. The research starts from that.
  - date: "2026-11-26"
    status: active
    who: akot
    note: >
      Research done, waiting for review. What the seller sees, from the 2.31 dists and a testnet
      run (test/live/payto-trustline-missing.ts, 7 checks passed): nothing, for every client we
      know of. Prior art: no x402 facilitator warns the seller before the first payment.
      Recommendation: the guide step in 0075, a refusal reader (0164), no seed check and no
      facilitator route. Decisions 1-9.
  - date: "2026-11-26"
    status: completed
    who: akot
    note: >
      Closed after PR #264 merged (4 commits). Two testnet runs, 7 checks passed; three notes
      (R-what-the-seller-sees, R-prior-art, S-recommendation). Follow-up: 0164 (refusal reader,
      M2); the guide step went into 0075; 0165 (seed check) was proposed and dropped.
---

# Find how a seller can learn that their payTo has no trustline

## Summary

As a seller who offers a new asset, I want to learn that my `payTo` has no trustline to it, so that
I add one before clients fail to pay me. Today nothing tells the seller. Find out what the
facilitator can do about it, and how other facilitators handle it, if any do.

## Context

As of 2026-11-26 (the task was written on 2026-11-02, against the `~2.28.0` pin):

- A `payTo` G-account needs a trustline to receive a classic asset, so a seller who offers a new
  asset without one can't be paid.
- 0078 answers `/verify` and `/settle` with `invalid_exact_stellar_payto_trustline_missing`, naming
  the account and the asset. That answer goes to the resource server, and the message also goes to
  the facilitator's log, which the seller can't see.
- Most payments don't get that far. Every `@x402/*` package is on `~2.31.0` (0145). Upstream's
  client simulates before it signs and throws a typed `TrustlineMissingError` with the account and
  the asset.
- 0092 is closed. MCP and the SDK answer `payto_trustline_missing`, name the account and the asset,
  and send nothing. That tells the buyer, not the seller.
- 0102 is closed. `@stellar-x402/sdk/seller` has `checkTrustline`, which answers `ok`, `missing` or
  `unknown` without signing. `examples/http-api` runs it at start: it stops on `missing` and warns
  on `unknown`. That is already one of the options below, a check in the resource server when it
  starts.
- The facilitator has no way to contact a seller: it only answers calls. The seller check reads a
  seller's 402, but cataloging starts from a settled payment, and a seller without a trustline
  never gets one.

## Implementation

Answer these, and record the sources in `notes/`:

- Does upstream's resource server pass `invalidReason` and `invalidMessage` on to the client, or
  log them? What does the seller see today, for each client?
- How do other x402 facilitators and SDKs handle a seller's missing trustline, or the same problem
  on other chains, such as a missing token account on Solana? Does any of them warn the seller
  before the first payment?
- What can we do, and what does each option cost?
  - a check in the resource server's middleware, when it starts or builds its offers;
  - a facilitator route that a seller calls to check an offer;
  - a CLI or docs step for seller onboarding;
  - a check of the `payTo` in the seller's 402 during the seller check.
- Should the answer also cover a `payTo` that doesn't exist?

Out of scope: the client's error (0092), and adding a trustline for the seller, which only the
seller can sign.

Clean-room rule: no OpenZeppelin relayer code (AGPL), not even as reference. Leave its x402 plugin
out of the comparison.

## Acceptance Criteria

- [x] What the seller sees today is recorded for each client, from the code or a testnet run
      ([R-what-the-seller-sees](notes/R-what-the-seller-sees.md), both)
- [x] Other facilitators and SDKs are compared in an `R-` note, with sources; if none handles it,
      the note says so ([R-prior-art](notes/R-prior-art.md): none warns the seller before the
      first payment)
- [x] An `S-` note gives a recommendation, with its costs, or the reason to do nothing
      ([S-recommendation](notes/S-recommendation.md))
- [x] Any work the recommendation needs is a backlog task (0164; the docs step went into 0075)

## Findings

- **What the seller sees: nothing, for every client we know of.**
  - MCP, our SDK and upstream's `@x402/fetch` all simulate with `@x402/stellar` and stop before
    signing. The seller gets one unpaid request, which looks like any visit, and the facilitator
    gets no call.
  - A payment that reaches `/verify`, because `payTo` lost the trustline after signing, gets a 402
    with the bare reason. The seller's server logs nothing. The account and the asset are only in
    the facilitator's log and in what an `onAfterVerify` hook would get.
  - Testnet run on 2026-11-26: trustline `5423fc57…`, removed `412aee46…`, merged `8ad5c17f…`.
    The buyer's USDC was unchanged.
- **Prior art.** Nobody warns the seller before the first payment.
  - Solana has the same problem (the ATA). Upstream refused to have the facilitator create it,
    because of rent drain, and shipped a diagnosis at `/verify`, as our 0078.
  - Solana's, CDP's and PayAI's docs tell the seller to set the account up before advertising.
  - Only Stripe Connect and Core Lightning tell the receiver beforehand.
- **Recommendation** (for the owner to confirm):
  - a "payTo can receive" first step in the seller guide (0075);
  - a refusal reader for `onAfterVerify` in `/seller`, used by the example (0164, M2): it also
    tells the seller about 0107's `pay_to_balance_missing`, which does reach `/verify`;
  - no `payTo` check at catalog seed, no facilitator route, and no portal check for now.
  - A `payTo` that doesn't exist needs nothing of its own.

## Issues Encountered

- **`pnpm add` rewrote unrelated lockfile entries**: it re-resolved the siwe/viem peers (zod 3 to
  zod 4). The lockfile was cut back by hand to the three new entries; `pnpm install
  --frozen-lockfile` and a later `--lockfile-only` both keep it.
- **Importing the example seller broke the facilitator's typecheck** (`rootDir`): the live script
  sets the seller up with the same settings itself (decision 2).
- **CI once failed on `settle.test.ts`'s settle budget block** (node 24, the first run of #264), a
  test this PR doesn't touch; the rerun passed. 0074's timing problem.

## Future Work

- 0164: a refusal reader for `onAfterVerify` in `/seller`, used by the example (backlog, M2).
- The seller guide step is in 0075's scope, not a task of its own.

## Design Decisions

### Emerged

1. **The testnet run is in `apps/facilitator/test/live/`, with the facilitator in the process**, as
   `pay-to-balance-missing.ts` runs it: a fresh key, one channel, a schema of its own in the
   compose database. This shows its log directly. Chosen over our public testnet facilitator, whose
   log is in CloudWatch and whose database is shared.
2. **The seller is rebuilt in the script with `createApp`'s settings**: upstream's Express
   middleware, the same route and price, and its one log line. The Bazaar extension is left out,
   since a refusal never reaches it. Importing `examples/http-api/src/app.ts` breaks the
   facilitator's `rootDir`, so the typecheck would fail.
3. **Three devDependencies on the facilitator, for that script only:** `@stellar-x402/sdk`
   (workspace), `@x402/express` and `@x402/fetch`, both `~2.31.0`. `pnpm add` also re-resolved the
   siwe/viem peers in the lockfile; that was left out, and the lockfile has only the three entries
   (`pnpm install --frozen-lockfile` passes).
4. **The client that reaches `/verify` is built by changing `payTo` after signing.** No client that
   skips the simulation exists. The trustline is removed after two payments are signed, and then
   the account is merged away, which also covers a `payTo` that doesn't exist.
5. **The MCP binary was not run again.** It pays through the SDK that the script runs, and its
   e2e E-14d/E-14e (2026-11-26 12:47, commit 30995a04) covers this case on testnet with 0 paid
   requests at the seller.
6. **Other chains were read on `x402-foundation/x402` main `520e5a05` / npm 2.32.0**, where
   upstream lives now. Facts about our own pin come from the 2.31 dists in `node_modules`. The
   sources are commit permalinks and quotes in the note, not archived in `sources/`.
7. **The docs step went into 0075, not a new task.** The seller guide is where it belongs, and a
   task of its own would hold one paragraph. Recorded in 0075's history; its owner is unchanged.
8. **0164 is M2 and medium.** It fixes what a seller misses today (0107's refusal).
9. **No seed check** (akot, 2026-11-26): a `payTo` check at catalog seed was proposed as 0165, M3,
   low, and dropped before the PR. No catalog we found does it, it protects buyers rather than
   telling the seller, and the case is rare. Chosen over merging it into 0164, whose package,
   milestone and reader differ.
