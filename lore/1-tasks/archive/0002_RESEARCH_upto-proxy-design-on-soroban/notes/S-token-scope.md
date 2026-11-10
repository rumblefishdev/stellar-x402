---
title: "Decision: any SEP-41 token, no on-chain allowlist; token is signed"
type: synthesis
status: mature
tags: [upto, decision, token]
links: []
history:
  - date: "2026-09-30"
    status: mature
    who: claude
    note: "Signed token param confirmed by okarcz; no-allowlist decided from research"
    spawned_from: ["notes/R-sep41-sac-allowance.md"]
---

# Decision: any SEP-41 token, no on-chain allowlist; token is signed

## Conclusion

- **Token parameter.** `token: Address` is the first parameter and the first signed arg, as
  confirmed by okarcz. This fixes F1.
- **Any token.** The contract accepts any contract that implements SEP-41 `approve` and
  `transfer_from`. There is no allowlist and no admin (see S-immutable).
- **Which tokens to accept is off-chain policy.** The facilitator lists assets in `/supported`
  and sellers choose in `accepts`.
- **Testing.** M1 tests three tokens: Circle testnet USDC, a self-issued SAC, and an in-repo
  custom SEP-41 token.

## Reasoning

1. **The proxy has nothing a token can steal.** It holds no funds and no shared balances. Its only
   state is nonces keyed by `(from, nonce)`, which a token contract cannot write, and re-entry is
   forbidden. A buggy or malicious token can only hurt the payer and seller who chose to use it.
2. **An allowlist would need an admin**, which goes against the immutable decision, or a new
   deployment for every asset. That goes against "any SEP-41 token" in the RFP.
3. **Binding the token in the signature** stops a facilitator from substituting one token for
   another.

## Known limitations (for the threat model)

A non-SAC token may do any of the following:
- emit events in another shape;
- charge fees on transfer, so the seller receives less than `actual_amount`;
- ignore allowance expiry.

The facilitator's settle-time simulation must check the balance changes. The event log alone is
not enough.
