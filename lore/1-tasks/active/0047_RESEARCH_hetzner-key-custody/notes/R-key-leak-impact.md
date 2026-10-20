---
title: "What a leaked facilitator key costs, and custody sized to it"
type: research
status: mature
spawned_from: R-key-custody-options.md
spawns:
  - S-key-custody-decisions.md
tags: [keys, custody, hetzner, threat-model, fees, openbao, kms]
links:
  - R-openbao-on-hetzner.md
  - ../../../../../docs/threat-model.md
  - ../../../../../packages/signer-pool/src/balance.ts
  - ../../../../../packages/signer-pool/src/setup.ts
history:
  - date: "2026-10-19"
    status: developing
    who: okarcz
    note: >
      Worth considering, not decided: the key guards only our own XLM float, so a file-based
      secret plus 0048 and a small float may beat OpenBao or KMS on cost.
  - date: "2026-10-19"
    status: developing
    who: okarcz
    note: "Preferred: OpenBao on the facilitator's server with auto-unseal; not yet an ADR."
  - date: "2026-10-19"
    status: mature
    who: okarcz
    note: "Decided (ADR 0013), without the cold keys: only the hot key is kept; top-ups left open."
---

# What a leaked facilitator key costs, and custody sized to it

> Decided in [ADR 0013](../../../../../docs/adr/0013-facilitator-key-custody.md) (2026-10-19):
> OpenBao on the facilitator's server with auto-unseal, **without the cold keys** proposed below.
> Every decision is in [S-key-custody-decisions](S-key-custody-decisions.md). okarcz: the move to
> Hetzner was about cost, not about leaving AWS.
>
> **Amended 2026-10-20** ([S-key-custody-decisions, B14–B20](S-key-custody-decisions.md#fee-float-and-top-ups)):
> the float is **100 XLM with the alarm at 25 XLM**, no upper limit, reviewed weekly after the
> mainnet deploy; top-ups are by hand (Friendbot on testnet, the company's exchange account on
> mainnet). A leak now reaches about 130 XLM. The numbers below are the 2026-10-19 sizing.

## Question

[R-key-custody-options](R-key-custody-options.md) and [R-openbao-on-hetzner](R-openbao-on-hetzner.md)
compare where the key can live. They don't size the loss. What can a thief do with the facilitator
key, and is OpenBao or KMS worth its cost against that?

## What a leaked key reaches

| It controls                                                  | Worst case                                                                                                                                                         | Loss                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Buyers' and sellers' tokens, `exact`                         | Nothing. The buyer's auth entry fixes amount and `payTo`; the key can only submit it as signed, and changing it breaks the signature.                                | none (ADR-R6: no custody of client funds) |
| The facilitator's own account (pays fee bumps)               | A Payment of all its XLM to the thief.                                                                                                                             | the float                               |
| The channels (weight 1, every threshold 0, `setup.ts`)       | `AccountMerge` takes each channel's ~1.5 XLM, or a new signer locks us out.                                                                                        | ~1.5 XLM a channel, plus downtime       |
| `upto` authorizations, once 0015 settles them                | With a buyer's signed entry, settle any amount up to the buyer's ceiling. The money goes to the buyer's chosen seller, not the thief; entries expire within the window. | overcharge inside the ceiling, no gain  |

```
key leaks ==> thief empties the fee account and the channels ==> float + ~1.5 XLM per channel lost
  ==> /settle stops ==> new key, account and channels, redeploy ==> hours of downtime
```

The cost of a leak is the float plus downtime. Downtime costs more than the XLM, and task 0048
removes most of it.

## How large the float needs to be

- A settlement costs about 41,000–45,000 stroops (0006; `balance.ts` assumes 45,000). The ceiling
  is `MAX_FEE_STROOPS`, 250,000. So 1 XLM pays about 220 settlements, or 40 at the ceiling.
- The repo has no mainnet traffic estimate.

| Settlements a day | XLM a day | Days 150 XLM lasts | At the ceiling |
| ----------------- | --------- | ------------------ | -------------- |
| 100               | 0.45      | ~330               | ~60            |
| 1,000             | 4.5       | ~33                | ~6             |
| 10,000            | 45        | ~3                 | <1             |

A proposal for launch:

- **Float:** about 150 XLM on the fee account, a few weeks of fees at early traffic.
- **Alarm:** low balance at 50 XLM spendable. `checkFacilitatorBalance` defaults to 100 XLM
  (`minSpendableStroops`), which would sit just under a 150 float; it is an option, not code.
- **Top-ups:** open (2026-10-19). The cold treasury account proposed here was declined with the
  other cold keys. Still: never an automatic top-up with a hot key, which would put the treasury
  behind it.
- **Channels:** about 1.5 XLM each, not spendable on fees; 20 channels add ~30 XLM to what a leak
  reaches.
- **Review** after the first weeks: keep 2–4 weeks of real fees.

Worst case at launch: about 180 XLM, which okarcz put at about $30 (2026-10-19).

## Custody against that loss

| Option                                    | Yearly cost          | A facilitator bug leaks env or memory | Root on the server               |
| ----------------------------------------- | -------------------- | ------------------------------------- | -------------------------------- |
| File secret via systemd credentials       | 0                    | mostly kept out (not in env, `docker inspect` or child processes) | key copied            |
| OpenBao on the facilitator's server       | 0 + our time         | only a revocable token leaks          | key copied (memory, or disk plus an auto-unseal key) |
| OpenBao on its own Cloud machine          | ~€78–144 + our time  | only a token leaks                    | can sign while there, can't copy |
| AWS KMS from Hetzner                      | ~$12–36              | only credentials leak                 | can sign while there, can't copy |

- Hetzner has no KMS, HSM or secret manager, so every option beyond a file brings in a system we
  run or AWS.
- OpenBao on the same server must unseal after each restart: an unseal key on the same disk gives
  root everything, Shamir needs a person after every reboot, and a cloud KMS seal brings AWS back.
- A separate OpenBao machine costs more each year than the whole launch float.

## Unseal on the same server

| | Auto-unseal (unseal key on the same disk) | Shamir by hand (e.g. 2 of 3 holders) |
| --- | --- | --- |
| A facilitator bug | only a revocable token leaks | only a revocable token leaks |
| Root on the running server | key copied | key copied, from memory |
| A stolen disk, backup or snapshot | key copied | useless without the shares |
| After a restart | signs again at once | settlements stop until holders unseal |
| Operations | none | an on-call rota at any hour |

Shamir protects only against a disk or backup copy, and costs downtime on every restart: a kernel
update, a crash, Hetzner maintenance, or a restart of another service on the shared server. With
about 180 XLM at stake, downtime costs more than the leak.

## Preferred option

> okarcz, 2026-10-19: decided in ADR 0013 with items 2–4 changed: no cold key, so 0048 is re-checked
> before mainnet, top-ups are open, and rotation is signed by the current key.

1. **OpenBao Transit on the facilitator's server**, with **auto-unseal**: the unseal key is a
   root-only file, kept apart from OpenBao's Raft data and left out of its backups. The
   facilitator holds only a token allowed `transit/sign/<key>`, over a unix socket or local mTLS.
   No new machine and no AWS. The same Transit `TransactionSigner` moves to a separate machine, or
   OpenBao's unseal to a KMS seal, if the stakes grow.
2. **0048** first: thresholds that keep the hot key below high, and a cold recovery signer. A leak
   then can't lock us out or merge channels, and recovery is one cold-signed transaction.
3. **A small float** with the 50 XLM alarm and cold top-ups.
4. **A rotation runbook** in 0026: add the new key with the cold key, switch, remove the old one.
5. **Upgrade when the numbers change:** a separate OpenBao machine or a KMS seal (or KMS
   itself) once a year of it costs less than a likely loss, for example a float in the thousands
   of XLM, or `upto` settlement (0015) making the key part of buyers' authorizations.

## Open questions

- Mainnet traffic, which sets the float.
- The number of mainnet channels (0038).
- ~~Who holds the cold recovery key and the cold treasury key (0048).~~ No cold key (2026-10-19).
- ~~Who holds the unseal key backup, and where.~~ AWS Secrets Manager (2026-10-20, B1–B13).
- ~~Where the fee account's top-ups come from.~~ By hand (2026-10-20, B14–B15); who makes the
  mainnet transfer is named before mainnet.
- Whether the dedicated server has a TPM, which would let systemd encrypt the credential to it.
