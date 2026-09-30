---
title: "Decision: facilitator is signed by the client and must authorize settlement"
type: synthesis
status: mature
tags: [upto, decision, facilitator]
links: []
history:
  - date: "2026-09-30"
    status: mature
    who: okarcz
    note: "Chosen by okarcz; confirmed by spike S5 and S8"
    spawned_from: ["notes/R-soroban-auth-model.md"]
---

# Decision: facilitator is signed by the client and must authorize settlement

## Conclusion

`facilitator` is part of the client's signed args, and `settle_upto` calls
`facilitator.require_auth()`. Only the facilitator the client chose can settle, and only for an
amount the facilitator signs off on (its entry covers the full call args, including
`actual_amount`).

## Reasoning

1. This is the same as `x402UptoPermit2Proxy` on EVM, where the witness includes the facilitator
   and the proxy checks the caller (R-x402-upto-specs).
2. Without the check, anyone who saw the client's entry could settle first with a lower amount and
   cheat the seller. Spike S5: a different submitter was rejected with `Error(Auth, InvalidAction)`.
3. The check works with both ways a facilitator can submit:
   - **as the transaction source**, through source-account credentials (S1, S6, S7);
   - **through a channel account**, with the facilitator signing a V2 address entry. In S8 the
     channel paid the fee and the facilitator paid 0.

## Consequences

- The `exact` rule "facilitator MUST NOT appear in any auth entry" must be narrowed for upto (see
  R-exact-stellar-facilitator-rules).
- Settling through a channel costs about 8.7k stroops more, because of the extra signature check
  and nonce entry.
- The facilitator's address is part of the payment. If it rotates its key, open authorizations
  bound to the old address can still only be settled by that address.
