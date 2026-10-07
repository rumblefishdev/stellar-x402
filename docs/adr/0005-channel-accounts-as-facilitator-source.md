# ADR 0005: Channel accounts count as the facilitator

- Status: accepted
- Date: 2026-10-07

## Context

`scheme_exact_stellar.md` says that at settlement the facilitator rebuilds the transaction "with
the facilitator as source". Its verification rules also say the facilitator's address must not
appear as the transaction source, an operation source, `from`, or in any auth entry of the
client's payload.

[ADR 0003](0003-settlement-channel-account-pool.md) settles every payment in the
`delegated-bump` shape:

- a channel account is the transaction source;
- the facilitator is the operation source;
- the facilitator pays a fee bump.

Each channel's master key is disabled and the facilitator key is its only signer. The literal
reading of the spec (the facilitator account itself as source) allows one pending transaction
per ledger, which would leave the channel pool unused for `exact`.

Upstream `verify()` protects only the signer addresses it is given, not our channel accounts.

## Decision

- **Our reading of the spec.** Channel accounts controlled by the facilitator key satisfy
  "facilitator as source". `exact` and `upto` both settle in the `delegated-bump` shape through
  the pool.
- **Channel safety check.** A payload is rejected when a channel address appears as:
  - the transaction source;
  - an operation source;
  - `from`;
  - the address of any auth entry.

  Both `Address` and `AddressV2` credentials are checked. The check runs in `/verify` and again
  in `/settle`.

- **Channel hardening.** The service refuses to start unless every channel has its master key
  weight at 0 and the facilitator key as its only signer.
- **`/supported` signers.** `signers` lists the facilitator key's address only, never the
  channels.
- **Raising it upstream.** We propose this reading to the x402 maintainers after Tranche 1.
  Nothing is pushed to `x402-foundation/x402` during M1.

## Rationale

- **The spec's rule is about control.** Its purpose is that the client never pays fees and
  never controls the transaction. Channel sourcing keeps both guarantees: the facilitator key
  signs everything and pays the fee bump, and the client signs only its auth entry.
- **It's invisible on the wire.** The resource server and client see one transaction hash per
  payment, as the spec requires. The e2e suite checks only that hash.
- **The literal reading costs throughput.** One pending transaction per ledger gives about 0.2
  settlements per second for `exact`, and the pool, a funded Tranche 1 item, would serve only
  `upto`.
- **The safety check closes a real gap.** Without it, a crafted payload could name a channel
  account as source or `from` and pass upstream verification.

## Alternatives considered

- **Literal spec shape for `exact`** (facilitator account as transaction source, pool only for
  `upto`). Rejected: about 1 settlement per ledger for `exact`, and two transaction shapes to
  maintain.
- **Passing channels to upstream as signers** so upstream's own safety check covers them.
  Rejected: upstream would then try to sign and select those addresses, and channels have no keys
  of their own.

## Consequences

- If upstream later reads the spec differently, `exact` settlement may need the literal shape.
  The pool would then serve `upto` only.
- Every channel address must be known to the verify path, so channel changes at runtime (task 0011) must update that check.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-4, AD-5, AD-12, AD-13
- [ADR 0003](0003-settlement-channel-account-pool.md)
- [`scheme_exact_stellar.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md)
