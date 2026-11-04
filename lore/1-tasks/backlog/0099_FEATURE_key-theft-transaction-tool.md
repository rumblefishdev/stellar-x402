---
id: "0099"
title: "Give the key theft transaction a tool and a testnet rehearsal before mainnet"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0013"]
related_tasks: ["0026", "0036", "0038", "0048"]
tags: [signer, keys, security, mainnet, priority-medium, effort-medium, platform]
links: []
history:
  - date: "2026-11-02"
    status: backlog
    who: stkrolikiewicz
    note: "Spawned from 0026: karczuRF's review of #104, which dropped the transaction's only rehearsal."
---

# Give the key theft transaction a tool and a testnet rehearsal before mainnet

## Summary

ADR 0013's answer to a stolen facilitator key is one transaction, signed by the old key, that moves
the fee account and every channel to a new Transit key. Nothing can sign it yet and it has never
run. Build the tool and rehearse it on testnet, so its first run isn't a real incident on mainnet.
A thief holds the same key, so that run is a race. This has to land before mainnet (0038), and
after 0048, whose decision can change the transaction.

## Context

- #104 dropped testnet's move to the OpenBao key, since nothing ran on another key (0036 decision
  15). That move was the same transaction, so it was also the only rehearsal.
- The procedure is in ADR 0013's "Rotation and break-in runbook": a new Transit key, then one
  transaction signed by the old key that creates the new key's account, moves each channel's
  signer and merges the old fee account into the new one. The service stops for it.
- 0036 decision 15: "The OpenBao key signs nothing but settlements, so no tool signs other
  transactions through it." This tool is the exception, and it needs writing down.
- `packages/signer-pool/src/setup.ts` only creates channels, and a Transit signature exists only in
  the facilitator's adapter (#102).
- If 0048 brings back a cold recovery signer, the old key may no longer be what signs this.

## Implementation

- Agree the exception in 0036 decision 15 with Payments, who own the key policy (ADR 0013).
- Decide how the tool reaches Transit. The network's AppRole lives in the facilitator's credentials
  and allows signing with its key: reuse it, or use a root token regenerated from the recovery key.
- The tool builds the transaction and signs it with the old key through Transit.
  - A `set_options` changes one signer, so a channel takes two operations, and a transaction holds
    100. With the account creation and the merge, one transaction moves 49 channels at most. Check
    this against the channel count, or change ADR 0013's "one transaction".
- Moving the facilitator to the new key: its policy, AppRole, address and `key_version`.
- Rehearse on testnet with the service stopped, time it, and write the steps into
  `docs/runbook.md`.

## Acceptance Criteria

- [ ] Given 0036 decision 15, when the tool lands, then the decision names this exception and Payments agreed to it
- [ ] Given a testnet fee account and its channels, when the tool runs, then the new key's account holds the fee account's balance and the new key is each channel's only signer (`checkChannel` passes)
- [ ] Given that move, when the facilitator restarts on the new key, then `/settle` works, and a transaction signed by the old key is refused
- [ ] Given a rehearsal, when it ends, then `docs/runbook.md` has its steps and its duration, and ADR 0013's description matches what ran
