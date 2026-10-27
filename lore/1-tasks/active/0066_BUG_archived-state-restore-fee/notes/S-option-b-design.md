---
title: "Option B: refuse with the spec's code and name the archived entries"
type: synthesis
status: developing
spawned_from: notes/R-facilitator-survey.md
spawns: []
tags: [facilitator, exact, fees]
links: []
history:
  - date: "2026-10-27"
    status: developing
    who: akot
    note: "Design after the facilitator survey and two reviews of the draft (GSD, BMAD)."
---

# Option B: refuse with the spec's code and name the archived entries

## Goals

- When archived state adds restore rent to a fee above the ceiling, `/verify` and `/settle` say so
  and name the entries.
- Count how often it happens, as evidence for ever revisiting sponsorship.

## Non-goals

- Paying restore rent, raising or splitting `MAX_FEE_STROOPS`.
- A restore script of our own: `stellar contract restore` does it.
- Estimating the fee after a restore; `upto` (0015).

## Anti-goals

- The diagnosis changes a verdict or its code. Upstream owns verification (AD-3).
- The happy path makes an extra RPC call.
- Client input reaches a metric label or an unbounded string.

## Decisions

1. **One decorator on the check, for both routes.** In `createChecker`
   (`apps/facilitator/src/settlement/verify.ts`), on the `!upstream.isValid` branch, only when
   `invalidReason === "invalid_exact_stellar_payload_fee_exceeds_maximum"`. `/settle` re-checks
   through the same checker (`main.ts`, `buildChecks`), and in the `upfront` flow it is called
   without a `/verify` first (m1-spine.md, Open Questions).
2. **One bounded diagnostic simulation.** Upstream's simulation is private and isn't returned on
   the fee path, and it builds its own RPC client, so we simulate once more. It has its own short
   bound (about 3 s, never more than `/settle`'s budget left), doesn't fail over and doesn't mark
   the shared URL failed, so a client payload never moves it. It is skipped when the budget is
   too short. An error, a timeout or no archived entries leaves upstream's answer as it was.
3. **Where the entries come from.** `SorobanTransactionData.ext.v1.archivedSorobanEntries`,
   indexes into the read-write footprint (what 0021 saw on Protocol 23). `restorePreamble` only as
   a fallback.
4. **The answer.** `invalidReason` stays upstream's. `extra` gets
   `{ reason: "invalid_exact_stellar_payload_archived_state", archived: [{ kind, contract | wasmHash, keyXdr }] }`,
   as `extra.reason` already carries our codes for channel accounts. `invalidMessage` is
   upstream's text followed by `; restores N archived entries: …`. The wording says the
   transaction adds restore rent, not that it is the only cause: the fee may still be over the
   ceiling after a restore. `/settle` drops `extra` (`failure()` in `settle.ts`), so there the
   message carries the entries.
5. **Entry kinds.** `instance`, `code`, `balance` (payer, `payTo`, or a contract-account payer),
   `data` for anything else. Temporary entries never archive.
6. **Bounds and data hygiene.** At most 4 entries listed, then `and N more`. Keys go out as base64
   XDR only, never decoded `ScVal` text. Asset and payer go in logs only (the payer is claimed,
   not verified); metric labels stay `{ route, kind }`.
7. **Observability.** A `logger.warn("verify_archived_state", …)` event and a counter by kind.
   `flagDrift` (`settle.ts`) skips this case: archived state is not `/settle` disagreeing with
   `/verify`.
8. **Abuse.** Anyone can make us run the extra simulation by sending a payment over the ceiling.
   It is bounded by AD-11's rate limits and decision 2's bound; the threat model says so.

## Who sees it

- Sellers: the full verify response in `@x402/core`'s `onAfterVerify` / `onVerifyFailure` hooks.
- Buyers through `@x402/core`: only the code (the resource server puts `invalidReason` into
  `PaymentRequired.error`). The README is their channel: their client already simulates before
  signing, and a payload sent to our `/verify` directly gets the full answer.
- Us: the log event and the metric.

## Docs

- `apps/facilitator/README.md`: the two rows that say "try again later" for this code become
  "check for archived state". A section per entry kind with `stellar contract restore`
  (`--id` + `--key-xdr`, `--wasm-hash` for code), checked against the pinned stellar-cli.
- `docs/architecture/m1-spine.md` AD-3: the diagnosis in the `/verify` and `/settle` steps.
- `docs/threat-model.md` "Fee inflation by rent": restore rent, the decision not to pay it above
  the ceiling (below it the facilitator still pays), the extra simulation's bound.
- `docs/adr/0007-fee-abuse-containment.md`: one line, as it owns the ceiling.

## Tests

- Base: `test/fee-agreement.test.ts` runs the real `ExactStellarScheme` against a local JSON-RPC
  whose `simulation()` can return `archivedSorobanEntries`. Unit cases in `test/verify.test.ts`,
  wiring in `test/build-verifier.test.ts`, `/settle` in `test/settle.test.ts`.
- Cases: an archived instance, code, payer balance and `payTo` balance; `restorePreamble`; more
  entries than the cap; `/settle` refused with the message; the diagnostic timing out or failing
  without moving the shared URL; a diagnostic that sees no archived entries; another refusal code
  and the happy path making no extra call.
