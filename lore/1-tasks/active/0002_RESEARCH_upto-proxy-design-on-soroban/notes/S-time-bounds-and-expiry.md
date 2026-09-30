---
title: "Decision: unix-second window plus a signed allowance expiration ledger"
type: synthesis
status: mature
tags: [upto, decision, time]
links: []
history:
  - date: "2026-09-30"
    status: mature
    who: okarcz
    note: "Unix seconds chosen by okarcz; allowance_expiration_ledger parameter emerged from research"
    spawned_from: ["notes/R-sep41-sac-allowance.md"]
---

# Decision: unix-second window plus a signed allowance expiration ledger

## Conclusion

- **The time window.** `valid_after` and `deadline` are `u64` unix seconds. Both are in the
  signed args. The contract requires `valid_after <= env.ledger().timestamp() <= deadline`. This
  follows the x402 `validAfter`/`deadline` semantics and was confirmed by okarcz.
- **The ledger expiry (emerged).** `allowance_expiration_ledger: u32` is a new parameter, passed
  to `approve` as `live_until_ledger`. The client signs it through the approve sub-invocation, so
  a changed value breaks the signature. The contract requires
  `allowance_expiration_ledger >= env.ledger().sequence()`, and it also becomes the TTL of the
  nonce entry (see S-nonce-storage).
- **Client and facilitator rules (spec, not contract):**
  - `allowance_expiration_ledger` equals the auth entry's `signatureExpirationLedger`;
  - it is at most `currentLedger + ceil(maxTimeoutSeconds / 5)`;
  - `deadline` is at most `now + maxTimeoutSeconds`.

## Reasoning

1. The approve arguments have to be known when the client signs (R-soroban-auth-model). The
   contract cannot compute an expiration ledger that matches the signed one, so it must be passed
   in.
2. We don't add it to the custom args, because it is already covered by the signed
   sub-invocation. Leaving it out keeps the root args equal to §6.2 plus `token`.
3. Settlement is refused once either bound passes: `deadline` in seconds, or the signed ledger
   through the built-in auth expiry and SAC `approve`. The effective window is the earlier of
   the two.

## Alternatives considered

- **Ledger numbers for the whole window:** consistent with Stellar, but departs from x402
  semantics. okarcz chose seconds.
- **Deriving the approve expiration from `deadline`:** not possible deterministically, because
  there is no fixed mapping between seconds and ledgers.
