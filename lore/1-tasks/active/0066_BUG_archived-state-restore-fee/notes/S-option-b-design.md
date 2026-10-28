---
title: "Option B: refuse as upstream does, and name the archived entries in the message"
type: synthesis
status: mature
spawned_from: notes/R-facilitator-survey.md
spawns: []
tags: [facilitator, exact, fees]
links: []
history:
  - date: "2026-10-27"
    status: mature
    who: akot
    note: "Design after the facilitator survey; kept to upstream's refusal plus one line of text."
---

# Option B: refuse as upstream does, and name the archived entries in the message

## What changes

Nothing in the verdict. Upstream already refuses a fee above the ceiling with
`invalid_exact_stellar_payload_fee_exceeds_maximum` and the message
`simulation-derived fee N stroops exceeds ceiling M stroops`, as r402 does; the OpenZeppelin plugin
sends no message at all ([R-facilitator-survey](R-facilitator-survey.md)). We keep that answer and
add one thing: when the payment's own transaction lists archived entries, the message says so.

```
simulation-derived fee 551887 stroops exceeds ceiling 250000 stroops; the transaction restores 1 archived entry: <key XDR>
```

## Decisions

1. **Where the entries come from: the payment itself.** `@x402/stellar`'s client builds the
   payment from a simulation, and `assembleTransaction` (stellar-sdk 16.3.0,
   `rpc/transaction.js`) puts that simulation's `transactionData` in the transaction, with
   `ext.v1.archivedSorobanEntries` (indexes into the read-write footprint). We read them from the
   transaction we already parse: no extra RPC call. A client simulation that returns
   `restorePreamble` makes the client throw (`handleSimulationResult`), so that case never reaches
   us.
2. **Description only.** The entries come from the client, so they only change the text; the
   verdict and the code stay upstream's, from its fresh simulation. A payment that lists no
   archived entries, or any other refusal, gets upstream's answer unchanged. An entry archived
   between building the payment and `/verify` isn't listed; upstream's message stays.
3. **One place, both routes.** In `createChecker` (`apps/facilitator/src/settlement/verify.ts`),
   on the refusal branch, only for `…_fee_exceeds_maximum`. `/settle` re-checks through the same
   checker and passes `invalidMessage` on as `errorMessage`.
4. **Bounded text.** At most 4 keys, then `and N more`. Keys as base64 `LedgerKey` XDR only, never
   decoded values.

## Docs

- `docs/threat-model.md`, "Fee inflation by rent": restore rent is rent too. Above the ceiling the
  payment is refused and the message names the entries; below it the facilitator pays, as for any
  rent.
- `apps/facilitator/README.md`: the rows that say "try again later" for this code add that it can
  mean archived state, which anyone restores from their own account before paying again. The
  restore is shown with the SDK (`RestoreFootprint` over the message's keys, as 0021's
  `token-matrix.ts` did): stellar-cli 28.1.0's `contract restore` takes a data entry's key as an
  `ScVal` with `--id`, not a `LedgerKey`, so the message's keys don't go into it as they are.

## Tests

- A payment over the ceiling whose transaction lists archived entries: the code stays, the message
  names them; on `/verify` and on `/settle`.
- More entries than the cap.
- Over the ceiling with no archived entries, and another refusal code: upstream's answer unchanged.
- Base: `test/fee-agreement.test.ts` (the real `ExactStellarScheme` against a local JSON-RPC).
