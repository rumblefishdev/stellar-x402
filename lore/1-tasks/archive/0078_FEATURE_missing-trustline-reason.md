---
id: "0078"
title: "Name a missing trustline in /verify's answer instead of a generic simulation failure"
type: FEATURE
status: completed
milestone: 1
related_adr: []
related_tasks: ["0018", "0021", "0066", "0092"]
tags: [facilitator, exact, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-28"
    status: backlog
    who: okarcz
    note: >
      Spawned from the Milestone 1 status check: the panel review response (§5, "Trustline
      onboarding") promises an actionable error for a missing trustline, and no task covered it.
  - date: "2026-10-30"
    status: active
    who: okarcz
    note: "Work started."
  - date: "2026-10-30"
    status: completed
    who: okarcz
    note: >
      PR #94 merged: a payment with no trustline to a classic asset gets a reason of its own, and a
      message naming the account, the asset and the ledger, after a second simulation of a payload
      with the payer's entry. Facilitator 640, signer-pool 160; 32 mutants caught. Decisions 1-14.
      Upstream's client waits for 0092, moved to M1 with packages/mcp; no new follow-ups.
---

# Name a missing trustline in /verify's answer instead of a generic simulation failure

## Summary

As a buyer or a seller testing with a fresh wallet, I want `/verify` to tell me that a trustline
is missing, and on which account, so that I know to add it instead of guessing why the payment
failed. Today the payment fails with upstream's generic `invalid_exact_stellar_payload_simulation_failed`.

## Context

- The panel review response (§5, "Trustline onboarding") says: "Our pre-flight simulation step
  detects a missing trustline before payment is attempted and returns an actionable error." The
  code doesn't do that yet.
- A classic asset's SAC (USDC on testnet, for example) moves funds only between accounts that
  hold a trustline to the asset. A payment fails in simulation when the payer has none, which
  means no balance either, or when the seller's `payTo` G-account has none. The `payTo` case is
  the one a new seller hits: the buyer did everything right, and the seller's account can't
  receive the payment. C-address holders and non-SAC SEP-41 tokens have no trustlines.
- `/verify` calls upstream `ExactStellarScheme.verify()` (0018). On a failed simulation it
  returns `invalid_exact_stellar_payload_simulation_failed`, writes the RPC's error text to
  `console.error` only, and doesn't pass it back to us. So our wrapper can't read the cause from
  upstream's answer.
- `/settle` reruns the same checks, so a fix in `/verify` covers it too.
- 0021's token matrix already sets up trustlines for the seller's classic assets
  (`apps/facilitator/scripts/token-matrix.ts`) and can produce both failing cases on testnet.

## Implementation

- Choose how to find the cause (open question, decide before coding):
  - **Check trustlines after a failed simulation:** when upstream answers `simulation_failed` and
    the asset is the SAC of a classic asset, read the payer's and `payTo`'s trustline entries with
    one `getLedgerEntries` call. This costs nothing on the happy path.
  - **Re-simulate ourselves after a failed simulation** and match the SAC's
    missing-trustline contract error in the result. This depends on the error text.
- Add two reasons, for example `invalid_exact_stellar_payer_trustline_missing` and
  `invalid_exact_stellar_payto_trustline_missing`. Put the account and the asset in
  `invalidMessage`, and list both reasons in the README's verify answers.
- Keep upstream's reason for every other simulation failure.
- Out of scope: the buyer-side step that tells the user to add a trustline (0092).

## Acceptance Criteria

- [x] Given a payment in a classic asset's SAC to a `payTo` without a trustline, when `/verify`
      runs, then it answers `isValid: false` with the `payTo` trustline reason, naming the account
      and the asset, and a test covers it
- [x] Given a payer without a trustline to that asset, when `/verify` runs, then it answers with
      the payer trustline reason, and a test covers it
- [x] Given a simulation that fails for any other reason, when `/verify` runs, then the answer is
      upstream's `invalid_exact_stellar_payload_simulation_failed` as before
- [x] Given both trustline cases on testnet, when they are run once, then the answers are recorded
      in this task

## Design Decisions

### From Plan

1. **Simulate again after `simulation_failed`** (okarcz, 2026-10-30): the SAC's error event gives
   the code and the account, so it reports the real cause with one extra call, and other failures
   keep upstream's reason unaided. Chosen over reading both trustlines (it needs the asset first,
   about two calls, and doesn't prove the cause) and over doing both.
2. **Only a real SAC gets our reason** (okarcz, 2026-10-30): any contract can emit `#13` with the
   same text, so the contract instance must be a `contractExecutableStellarAsset`; a token that
   isn't keeps upstream's reason. One more read, on a failed simulation only. Chosen over trusting
   the event.
3. **A failed lookup keeps upstream's answer** (okarcz, 2026-10-30): the payment is refused either
   way, so it is logged, not a 500, with a limit of its own. Chosen over sharing upstream's limit
   (a slow upstream leaves it no time) and over a 500.
4. **One `payTo` message for a missing trustline and an unfunded account** (okarcz, 2026-10-30):
   the event doesn't tell them apart, and "the account must exist and hold one" is true of both.
   Chosen over a third reason with one more read.
5. **The payer's message says `payTo` wasn't checked** (okarcz, 2026-10-30): the SAC stops at the
   payer, so a seller missing one too shows up on the next try. Chosen over no note and over
   checking `payTo` as well.
6. **3 s for the whole lookup** (okarcz, 2026-10-30): `FallbackRpc`'s 10 s per URL over two calls
   would hold a refusal 30 s or more in an outage, for a cause that only explains it.
7. **The lookup is a dep of `VerifierDeps`, in its own file** (okarcz, 2026-10-30): required, so
   the compiler finds any wiring missed; `verify.ts` stays free of it while #80 and #83 change
   that file.
8. **A muxed `payTo` keeps upstream's reason** (okarcz, 2026-10-30): the event names the G-address,
   which doesn't match the M-address as given. Rare and safe.

### Emerged

9. **`message` asset name from the SAC's `METADATA`, or its contract address**: the instance read
   already returns `CODE:ISSUER`, so naming the asset costs no call.
10. **Upstream's client waits for 0092, now in M1** (okarcz, 2026-10-30, from code review; amended
    the same day, Adam's review of #94): the panel response's "actionable error" holds for
    upstream's client only once 0092 is done. Until then it holds for a client with its own
    payload and a trustline removed after signing. 0092 moved from M2: `@x402/stellar` 2.29.0
    throws `TrustlineMissingError`, so it is a version bump plus that error, and `packages/mcp` joins
    it, since `pay.ts` answers a seller's missing trustline with `insufficient_funds`. The bump
    stays in 0092.
11. **A `/settle` budget that runs out during the lookup stays a timeout** (code review): decision
    3 holds in `/verify`, but `settle.ts` bounds the whole check, so a hung lookup in the budget's
    last 3 s answers `…_timeout`. Nothing is claimed and the same payment may be sent again;
    avoiding it needs a new parameter on `Check`.
12. **A lookup needs the payer's one auth entry** (okarcz, 2026-10-30, Adam's review of #94): a
    forged payload is free and reached `simulation_failed` and `#13`, so it cost 3 RPC calls where
    it had cost 1, on the shared client. `payerNonce` in the condition leaves 1 for no entry and 2
    for a junk one. Chosen over docs alone and over leaving the docs for later.
13. **The two reasons' message is logged in this PR** (okarcz, 2026-10-30, Adam's review of #94):
    only `invalidMessage` names the account and the asset, and an operator had neither. Adam
    proposed widening #83's log condition once it's in; #83 is still open, so this PR adds it, on
    `verified` and `settled`, and whichever merges second joins the two conditions. Chosen over
    waiting for #83 and over a backlog task.
14. **The message names its ledger** (okarcz, 2026-10-30, Adam's review of #94): a lagging RPC can
    answer this too, so "as of ledger N" comes from the simulation. Taken with it:
    `trustline_lookup_failed` carries `network`, and a captured `#13` fixture catches a change in the
    event's shape, which the hand-built events wouldn't.

## Implementation Notes

- `src/settlement/trustline.ts`: `createTrustlineLookup()`, the two reasons, the event decoding and
  the SAC check. `verify.ts` calls it just before answering upstream's refusal, when the payer is
  known; `/settle` gets it through the same checks. `buildChecks()` wires it.
- Tests: `test/trustline.test.ts` (new, 14), three in `verify.test.ts`, two in
  `build-verifier.test.ts` through `/verify` and `/settle`'s check, one with the real lookup. `settle.test.ts`'s
  failed check now carries a message. Changed fixtures only:
  `missingTrustline` added to the `createChecker` calls in `verify.test.ts` and `settle.test.ts`,
  and `simulateTransaction` to the fake RPC in `build-verifier.test.ts`.
- 12 mutants caught: no SAC check, any contract error, any contract, any account, reasons swapped,
  no `payTo` note, any executable, no limit, no log, every refusal, never looking, no wiring.
- Code review (four reviewers): 7 fixes applied, 10 points rejected, decisions 10 and 11. 10 more
  mutants caught: a wrong instance key (2), each event guard (5), a 30 s default, `/settle` dropping
  the message, a muxed `payTo` matched.
- Testnet, 2026-10-30, throwaway accounts and asset, signed payloads through `buildVerifier`:
  - both trustlines: `isValid: true`;
  - `payTo`'s removed after signing: `invalid_exact_stellar_payto_trustline_missing`, "G… has no
    T078:G… trustline: the account must exist and hold one";
  - the payer's removed after signing: `invalid_exact_stellar_payer_trustline_missing`, the same
    with "; payTo wasn't checked";
  - both removed: the payer's reason.
- Unsigned simulations of USDC's SAC: `Error(Contract, #13)` with "trustline entry is missing for
  account", G-address; an unfunded `payTo` the same; a low balance `#10`.

- Adam's review of #94: all four confirmed points stand; 0092 moved (decision 10). `/verify`'s
  trigger now runs through the real scheme in `fee-agreement.test.ts`, on a simulation captured
  from testnet (`test/fixtures/trustline-missing.json`); `trustline.test.ts` reads the same fixture.
- Not covered: `/settle` gives these reasons only from its check before the claim. A trustline
  removed after that answers `settle_exact_stellar_simulation_failed` from the pool, whose message
  doesn't name the account. The window is the time between the check and the pool's simulation.
- 10 more mutants caught: no guard, upstream's code renamed and no `payer` (both through
  `fee-agreement.test.ts`), no ledger, no `network`, each log with no message and with every message
  (4), a wrong event topic.

## Issues Encountered

- **Upstream's client refuses first.** `ExactStellarScheme.createPaymentPayload` simulates before it
  signs, and throws `Stellar simulation failed with error message: HostError: Error(Contract, #13)`
  for both cases, so its users never reach `/verify`. The testnet run signed with the trustline in
  place and removed it afterwards. The answers serve a client with its own payload and a trustline
  removed after signing; the panel response's "actionable error" for upstream's client needs
  0092, in M1 since Adam's review. The raw `HostError` holds for our `~2.28.0` pin; 2.29.0 throws
  `TrustlineMissingError`.
