---
title: "Decision: zero settles without transfer; degenerate inputs rejected"
type: synthesis
status: mature
tags: [upto, decision, validation]
links: []
history:
  - date: "2026-09-30"
    status: mature
    who: claude
    note: "Decided from spec + SAC research; zero path proven by spike S6"
    spawned_from: ["notes/R-x402-upto-specs.md"]
---

# Decision: zero settles without transfer; degenerate inputs rejected

## Conclusion

- **`actual_amount == 0` is accepted.** The contract consumes the nonce, calls `approve` (the
  signed tree requires it), **skips** `transfer_from` and emits the settlement event with
  `actual_amount = 0`.
  - A facilitator normally sends **no transaction** for a zero settlement, as the spec allows. The
    contract path exists so an authorization can be explicitly used up.
- **Rejected inputs:**
  - `max_amount <= 0` → `InvalidAmount`
  - `actual_amount < 0` → `InvalidAmount`
  - `actual_amount > max_amount` → `AmountExceedsMax`
  - `from == to` → `SelfPayment` (emerged)
  - `to == current_contract_address` → `InvalidRecipient` (emerged, from PR #1 review)

## Reasoning

1. **Why accept 0.** The spec says the settled amount MAY be 0 (R-x402-upto-specs).
2. **Why skip the transfer at 0.** A SAC `transfer_from` of 0 still emits a `transfer` event and
   runs the trustline checks (R-sep41-sac-allowance). That event would be misleading, and it can
   fail for reasons unrelated to the payment.
3. **Why reject `from == to`.** A self-payment achieves nothing, but it would add fake volume to
   the Bazaar ranking, which counts transaction volume and distinct buyers. Rejecting it on-chain
   is free.
   - This does not stop wash trading between two accounts. That is a Bazaar ranking concern.
4. **Why reject `to == proxy`.** The contract is immutable and has no withdraw function, so tokens
   paid to it are locked for good. It would also break invariant I1 (the proxy's balance never
   changes).
5. **No separate check that `valid_after < deadline`.** An empty window can never be satisfied
   and fails the time check anyway.
