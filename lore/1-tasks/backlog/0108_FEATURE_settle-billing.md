---
id: "0108"
title: "Charge for settlements past the free quota"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0007"]
related_tasks: ["0024", "0106", "0107"]
tags: [facilitator, pricing, billing, priority-medium, effort-large, platform]
links:
  - ../../../docs/adr/0007-fee-abuse-containment.md
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-11-03"
    status: backlog
    who: akot
    note: "Spawned from 0024: pricing after the free quota, later than the keys."
---

# Charge for settlements past the free quota

## Summary

Past its free quota (0107), a key holder pays per settlement, on the model of Coinbase CDP
($0.001 each); the RFP asks for "mainnet pricing configurable" (decided by akot, 2026-11-03). This
comes after the keys and doesn't block `stellar:pubnet`: until it lands, the operator raises an
account's limit by hand.

## Decisions to make here

- **The price.** $0.001 is about 0.00145 XLM at $0.69 per XLM, which is the typical USDC
  settlement's fee (about 14,500 stroops), so above that rate a settlement costs us more than it
  earns. At the fee ceiling (250,000 stroops) that happens above about $0.04 per XLM. A fixed price
  in config, or the fee charged plus a margin with a minimum.
- **How it is paid.** Prepaid USDC credited to the account, or an invoice. ADR 0007 says the
  facilitator "never holds client or seller funds and never extends credit": prepaid holds
  funds and an invoice extends credit, so either changes that line; check it against the RFP's
  "Remain non-custodial", which is about payments.
- **What happens at zero** (prepaid) or unpaid (invoice): the same refusal as a spent quota.
- The company's side: who issues invoices or receipts.

## Implementation

- The price in config, never in code.
- The account's paid usage and balance on the portal's dashboard (0106).
- Docs: the facilitator README, ADR 0007.

## Acceptance Criteria

- [ ] Given an account past its free quota, when it settles, then it is charged the configured
      price and the dashboard shows it
- [ ] Given an account that can't pay, when it calls `/settle`, then it is refused with nothing
      signed
- [ ] Given the price, when the operator changes it, then only config changes
