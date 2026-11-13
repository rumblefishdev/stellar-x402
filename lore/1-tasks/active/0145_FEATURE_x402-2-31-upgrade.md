---
id: "0145"
title: "Raise the @x402 packages from 2.28.0 to 2.31.0 across the repo"
type: FEATURE
status: active
related_adr: []
related_tasks: ["0136", "0140", "0130"]
tags: [upstream, dependencies, facilitator, priority-medium, effort-medium]
links: []
history:
  - date: "2026-11-13"
    status: backlog
    who: akot
    note: >
      Spawned from 0136's parity work: the Rust crate answers as @x402/express 2.31.0, the newest
      upstream, while the repo's TypeScript is on 2.28.0. A task of its own, as it touches the
      facilitator in production (akot, 2026-11-13).
  - date: "2026-11-13"
    status: active
    who: akot
    note: "Work starts, after 0136's PR #177 merged."
---

# Raise the @x402 packages from 2.28.0 to 2.31.0 across the repo

## Summary

As the team, we want our TypeScript on the newest `@x402` packages, 2.31.0, so the facilitator,
the TypeScript examples and the Rust crate follow the same upstream.

## Context

- Every package that uses upstream pins `~2.28.0` (2026-09-29): `apps/facilitator`,
  `apps/mcp-local` and its `e2e`, `examples/http-api`, `examples/mcp-metered` (`@x402/mcp`),
  `packages/bazaar`, `packages/mcp`, `packages/signer-pool`. Since then 2.29.0 (2026-10-28),
  2.30.0 (2026-11-04) and 2.31.0 (2026-11-12) came out.
- 0136 holds the Rust crate equal to `@x402/express` 2.31.0 (its decision 23), checked against a
  scratch copy of `examples/http-api` on 2.31.0. Until this task, our own twin answers otherwise in
  the places listed below.
- `@x402/express` 2.31.0 needs `express` `^5.3.0` as a peer; the repo has 5.2.1.

What changed between 2.28.0 and 2.31.0, read from the built packages (no changelog ships):

- `@x402/core`, the seller's side: a 402 with an `error` repeats it in the body (`{error}` in
  place of `{}`); HEAD matches a GET route, and `*` no longer matches OPTIONS; the facilitator
  client reads at most 1 MiB of an answer (`http response body too large: limit 1048576 bytes`);
  `PAYMENT-SIGNATURE` must decode to a JSON object; a failing `beforeVerify` or `beforeSettle` hook
  now refuses the payment; an `afterSettle` hook can abort (`AfterSettleAbortError`); a settlement
  override above the authorized amount is refused (`upto`); a CAIP-2 network must match
  `^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$`; `accepts` holds at most 1024 terms.
- `@x402/core` 2.31.0 depends on `zod` `^4.6.6` (2.28.0: `^3.24.2`), and so do
  `@x402/extensions` and `@x402/mcp`; the repo is on zod 3.25.76. `packages/bazaar`'s schema
  for 0130 (`service-metadata.ts`) extends core's `ResourceInfoSchema` with zod 3 fields, and on
  2.31.0 every parse of it throws `Invalid element at key "serviceName": expected a Zod schema`
  (checked 2026-11-13 in a scratch install). `/verify` and `/settle` parse every request with
  it (`app.ts`, `parsePaymentRequest`), so a bump alone answers both 500 `internal_error`, and
  the seller check fails every listing. With zod 4 in `packages/bazaar` a payment with 6 tags
  parses and `tags: "x"` is refused, as 0130 wants. 2.31.0 does not carry 0130's upstream fix:
  `ResourceInfoSchema` still refuses an over-long `serviceName`, `tags` or `iconUrl`.
- The facilitator side, read 2026-11-13: `ExactStellarScheme.verify` is unchanged (comments
  only), and the exact client builds the same transaction, with typed errors when its
  simulation fails (`TrustlineMissingError`, `InsufficientBalanceError`,
  `SimulationFailedError`). Upstream's `settle()` passes `errorMessage` on and answers
  `TRY_AGAIN_LATER` as `settle_exact_stellar_transaction_submission_retryable`; ours never calls
  it (AD-3), and our submitter retries `TRY_AGAIN_LATER` itself. `x402Facilitator`'s 193 lines
  change hook semantics (`onVerifyFailure` no longer runs for `isValid: false`, a `beforeSettle`
  abort answers `success: false`, a throwing `after*` hook is logged); ours does not use the
  class. The wire types (`VerifyResponse`, `SettleResponse`, `SupportedResponse`,
  `PaymentRequirements`) are equal. `HTTPFacilitatorClient` sends the same body;
  `settleWithPendingRetry` is unchanged, so our `settlement_pending` repeat holds.
  `decodePaymentRequiredHeader` throws on JSON that is not an object, which the seller check
  answers `unreadable_402` as before. A discovery page of 100 stays under 1.6 MB, below the
  client's 4 MiB. `@stellar/stellar-sdk` `^16.4.1`: the lockfile has 16.4.1. Still Apache-2.0,
  now with `LICENSE` and `NOTICE`; the repository is `x402-foundation/x402`.
- `@x402/mcp` 2.31.0 needs `@modelcontextprotocol/sdk` `^1.32.0`; the repo asks for `^1.30.1`.
  `@x402/express` 2.31.0 also names `@x402/paywall` `^2.31.0` as a peer.
- `@x402/express`: an unexpected settle error answers `{"error": "settlement_failed"}`; text
  bodies for custom 402s.
- `@x402/extensions` (bazaar): the declared method is one the input can take (GET for a query,
  POST for a body); the discovery client reads at most 4 MiB.
- `@x402/fetch`: a 402's body is read up to 1 MiB (`ResponseBodyTooLargeError`).

## Implementation Plan

- Read the facilitator-side diffs (`@x402/core` facilitator, `@x402/stellar`) against
  `apps/facilitator`'s verify and settle, and 0130's upstream fix. Done: above (akot,
  2026-11-13); nothing in the facilitator changes but the zod of `packages/bazaar`.
- Move `packages/bazaar` to zod 4 with the bump, or `/verify` and `/settle` break.
- Raise every `@x402/*` to 2.31.0 and `express` to `^5.3.0`; run the tests, the MCP e2e run and a
  paid testnet request through the facilitator.
- Re-capture any fixture taken from 2.28.0 output that changes.

## Implementation Notes

- The bump: `92ebe3f3`. `pnpm test` on it: every package passes, the facilitator 1012 tests
  (3 skipped) against the local PostgreSQL.
- MCP testnet run, 2026-11-13, at `706a8e9a`: `pnpm mcp:e2e`, 121 of 121
  (`apps/mcp-local/e2e/results/testnet-results.json`). The buyer is `packages/mcp` on
  `@x402/fetch` 2.31.0, the seller `examples/http-api` on `@x402/express` 2.31.0, the
  facilitator this branch's build. Two payments of 0.001 USDC, the facilitator paying the fees:
  E-21 `118b37d00e3590bb8090815b4d0385cc0cc3923d0a3f1ccf963c0629ce0f789e`, E-22a
  `494233720028a9e56592580d088e733a5bf5e6fd033418ca05c3d4cc89cef6b9`. Buyer
  `GDARC6Q2SB2O6BQ4M3OXD75363YRU5QXDRRC53IHDMMDREL6TNO457VZ` and seller
  `GDHBG2354YS6ONMU6P22EKNEXQTRQUI4J3LSCNRRE2DWK3EYZ4UW2LQT` are new friendbot accounts; the
  buyer's 0.05 USDC came from a path payment on testnet's exchange, as in 0136.
- Parity run, 2026-11-13: 0136's harness, unchanged in its 45 requests, with the repo's own
  `examples/http-api` (`@x402/express`, `@x402/core`, `@x402/stellar`, `@x402/extensions`
  2.31.0 installed; its `src` equals 0136's scratch twin) and `examples/weather.rs` behind one
  fake facilitator. The terms are equal; 43 answers are equal, compared on status,
  `Cache-Control`, `Content-Type` without express's `; charset=utf-8`, `PAYMENT-REQUIRED`,
  `PAYMENT-RESPONSE`, body, other headers and the calls the facilitator got. OPTIONS (express
  200 `GET, HEAD`, axum 405) and POST on the GET route (express 404, axum 405) differ, the
  frameworks' own answers, as in 0136. The harness stays out of the repo, as 0136 decided.
- No fixture needed re-capturing: every test passes on 2.31.0, and the Rust crate's 402 fixture
  (captured from 2.28.0) is what its test compares with, while the parity run finds 2.31.0's
  terms equal to the crate's.

## Design Decisions

### Emerged

1. **zod 4 in `packages/bazaar` only** (2026-11-13). It is the one place the repo builds a schema
   from upstream's (`service-metadata.ts`). The facilitator's `config.ts` and `discovery.ts`,
   `packages/mcp`, `apps/mcp-local`, `examples/http-api` and `infra` parse with their own zod 3
   schemas and pass on 2.31.0; moving them changes config parsing in production for no gain to
   this bump. Two zods are in the tree (`pnpm why zod`); one `@x402/core` and one
   `@stellar/stellar-sdk`, as AD-14 asks.
2. **`@modelcontextprotocol/sdk` `^1.32.0` everywhere**, as `@x402/mcp` 2.31.0 asks, so the
   workspace resolves one version (1.32.2). pnpm still keeps two peer variants of it, one per zod;
   `examples/mcp-metered`, the only user of `@x402/mcp`, is a placeholder.
3. **`express` `^5.3.0` in the facilitator too**, not only in `examples/http-api`, which
   `@x402/express` needs it for: one express for the repo's own code. The MCP SDK's own range
   still holds 5.2.1 in the lockfile.
4. **AD-14 and its guard move with the pin**: `m1-spine.md` names `~2.31.0`, and
   `xdr-fixture.test.ts` checks `@x402/stellar` 2.31.
5. **No `minimumReleaseAgeExclude`**: pnpm 11 holds back a release younger than a day and wrote
   the six 2.31.0 packages into `pnpm-workspace.yaml` at the bump. A fresh
   `pnpm install --frozen-lockfile` passes without them, so they are not kept.
6. **`@stellar/stellar-sdk` `^16.4.1` in every package** (review of #184, stkrolikiewicz,
   2026-11-13): the range `@x402/stellar` 2.31.0 asks for. With `^16.3.0` only the lockfile kept
   one copy; an install that resolves otherwise could give our code 16.3.x beside upstream's
   16.4.1, the two copies AD-14 prevents. `xdr-fixture.test.ts` now also checks that upstream
   loads the copy of the SDK we load, which its `/^16\./` did not show.
7. **A test names the zod major** (same review): `packages/bazaar/test/zod-major.test.ts` fails
   when the package's zod is not the major of `@x402/core`'s. The other tests fail then too, with
   `expected a Zod schema`, which doesn't name the cause. AD-14 and the spine's version table now
   list the second zod.
8. **Citations of upstream follow the pin where the code was read again** (same review):
   `@x402/mcp`'s `createPaymentRequiredResult` answers the same in 2.31.0 (it now copies
   `accepts` first), so `seller-check.ts` and the test's fake MCP seller cite 2.31.0; so do
   `main.ts` (the same constructor, two lines lower) and `validate.ts` (`routeConfig.… || ""`).
   Archived tasks, ADRs and the planning docs keep the version they were written against.

## Acceptance Criteria

- [x] Every package in the repo is on `@x402` 2.31.0, and `pnpm test` passes
- [x] Given a payment from `@x402/fetch` 2.31.0 on testnet, when our facilitator verifies and
      settles it, then it moves the money, and the transaction hash is recorded (Implementation
      Notes: E-21, E-22a)
- [x] Given the requests of 0136's parity run, when `examples/http-api` and the Rust crate's
      example answer them, then they answer the same, framework differences aside (43 of 45;
      OPTIONS and POST are the frameworks')
