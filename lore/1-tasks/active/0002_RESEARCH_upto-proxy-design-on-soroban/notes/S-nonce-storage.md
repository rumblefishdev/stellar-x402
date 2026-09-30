---
title: "Decision: x402 nonce in temporary storage, alive until the allowance expiration ledger"
type: synthesis
status: mature
tags: [upto, decision, nonce, storage]
links: []
history:
  - date: "2026-09-30"
    status: mature
    who: claude
    note: "Decided from research; replay layers proven by spike S2 and unit test"
    spawned_from: ["notes/R-sep41-sac-allowance.md"]
---

# Decision: x402 nonce in temporary storage, alive until the allowance expiration ledger

## Conclusion

- **Type and key.** `nonce: BytesN<32>` (random, client-chosen), stored under
  `DataKey::Nonce(from, nonce)` in **temporary** storage with the value `()`.
- **Lifetime.** When the nonce is consumed, the entry's TTL is extended so it lives until at
  least `allowance_expiration_ledger`.
- **Behaviour.** A nonce that is already present gives `NonceUsed`. A read-only
  `is_nonce_used(from, nonce) -> bool` lets the facilitator verify.

## Reasoning

1. **Two layers of replay protection.** The built-in auth nonce already makes each signed entry
   single-use; spike S2 shows `Error(Auth, ExistingValue)`. The x402 nonce adds protection at the
   payload level:
   - it covers a client that signs two entries with the same x402 nonce;
   - it gives the facilitator an on-chain "already settled?" check.
2. **Why temporary storage.** A payload can't settle after `allowance_expiration_ledger`: the
   built-in auth expiry and `approve` both reject it. So the entry only has to live that long.
   Temporary storage costs less rent than persistent, and expired entries are removed for good.
3. **The TTL is always allowed.** SAC `approve` already requires
   `live_until <= max_live_until_ledger`, so the TTL extension can never exceed `max_ttl`. The
   contract still checks this, so a custom token cannot cause a host error.
4. **Scoped per payer.** The key includes `from`, as Permit2 nonces are per owner. Payers can't
   collide with each other or grief each other.

## Alternatives considered

- **Persistent storage:** needs rent for about 6 months or restoration, and gives no benefit after
  expiry. Rejected.
- **No contract nonce, relying only on the built-in auth nonce:** meets the single-use property
  for a well-behaved client, but gives up the on-chain check and the defence against a client
  that signs twice. Rejected; it costs about one extra temporary entry per settlement.
