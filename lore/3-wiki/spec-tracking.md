# Tracking the x402 spec

The RFP asks the facilitator to "Track spec evolution through grant period"
(`docs/rfp/07-x402-facilitator-bazaar.md`). This page says what we follow and how a change reaches us.

## What we follow

- `x402-foundation/x402`: the v2 specification, `scheme_exact_stellar.md`, the Bazaar extension
  (`specs/extensions/bazaar.md`) and the `upto` scheme, including our own Stellar `upto` proposal.
- The `@x402/*` packages, all on one pinned minor (spine AD-14).
- Stellar network settings that bound settlement: protocol version and Soroban ledger limits
  (ADR 0003 records the limits and the date they were read).

## How a change reaches us

- A new `@x402/*` minor is a deliberate bump of the one pin (AD-14), with the facilitator's tests.
- The gate runs upstream's unmodified e2e suite at a pinned upstream commit (ADR 0009, AD-15), so
  moving that commit shows what a spec change breaks.

## Not decided yet

- Who reads upstream's spec changes, how often, and where a relevant change is recorded: the
  owner's call.
