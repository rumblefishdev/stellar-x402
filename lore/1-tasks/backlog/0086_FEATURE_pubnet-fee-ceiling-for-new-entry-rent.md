---
id: "0086"
title: "Set the pubnet fee ceiling from what a new persistent entry's rent costs there"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007"]
related_tasks: ["0066", "0021", "0010", "0024"]
tags: [facilitator, exact, fees, pubnet, priority-high, effort-small]
links: []
history:
  - date: "2026-10-30"
    status: backlog
    who: karolkow
    note: >
      Spawned from the review of 0066's PR: on pubnet the first payment to a fresh C-address
      costs 441,874 stroops of resource fee, over the 250,000 default ceiling, with no archived
      state involved.
---

# Set the pubnet fee ceiling from what a new persistent entry's rent costs there

## Summary

As a seller whose `payTo` is a contract account, or who sells for a non-SAC token, I want my
buyers' first payment to settle on pubnet, so that I can be paid at all. Today the facilitator
refuses it with `invalid_exact_stellar_payload_fee_exceeds_maximum`: the payment creates the
seller's balance entry, its rent is paid up front, and on pubnet that rent alone is above
`MAX_FEE_STROOPS`. Since the first payment never lands, the balance never exists, and every
later payment is refused the same way.

## Context

- Measured 2026-10-30 (`simulateTransaction` of an XLM SAC `transfer` of 1 stroop from a funded
  G-account, nothing sent), `minResourceFee`:

  | Recipient | testnet | pubnet |
  | --- | --- | --- |
  | an existing G-account | 9,499 | 9,499 |
  | a fresh C-address (creates a persistent balance) | 119,874 | 441,874 |

- `MAX_FEE_STROOPS` defaults to 250,000 (`apps/facilitator/src/config.ts:142`); the check adds
  the inclusion fee on top (upstream `@x402/stellar` 2.28.0 `exact/facilitator` `_verify`).
- Rent is paid up to the network's minimum persistent TTL. Reported by the review's network
  read (to re-measure): 2,073,600 ledgers (~120 days) on pubnet, 120,960 (~7 days) on testnet,
  with the same rent rate inputs. That is why testnet runs never showed it.
- Who is affected: a SAC payment to a C-address seller's first balance; any non-SAC token
  payment that creates a balance; any restore of archived state (0066), which costs more on
  pubnet for the same reason. USDC to G-accounts is a trustline and never pays this rent.
- 0066 names archived entries in the fee refusal; a new-entry payment lists none, so its
  refusal names nothing and doesn't say why.
- 0010 measures inclusion-fee bids on mainnet, not rent; nothing tracks this today.

## Implementation

- Measure on pubnet, with read-only simulations, the resource fee of the payments the
  facilitator will see: SAC and non-SAC transfers to an existing and a fresh G- and C-address,
  and a restore of a balance and of an instance.
- Decide from those numbers: a pubnet ceiling, or a separate rent allowance next to the
  ceiling, and how it sits inside 0024's spend budgets.
- Decide whether a new-entry refusal says why, as 0066 does for archived entries.
- Update ADR 0007 and the threat model ("Fee inflation by rent") with pubnet figures.

## Acceptance Criteria

- [ ] Given the measured pubnet fees, when the ceiling or rent allowance is chosen, then ADR
      0007 records the value and the measurement it comes from
- [ ] Given a first payment to a fresh C-address in a SAC on pubnet, when `/verify` runs, then
      it is accepted, or the refusal and the docs say why it is refused
- [ ] Given the threat model, when it is read, then its rent figures are pubnet's
