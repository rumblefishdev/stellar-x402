---
title: "Decision: OpenBao Transit in a container on the facilitator's server, hot key only"
type: synthesis
status: mature
spawned_from: R-key-leak-impact.md
spawns:
  - ../../../../../docs/adr/0013-facilitator-key-custody.md
tags: [keys, custody, hetzner, openbao, decision]
links:
  - R-key-leak-impact.md
  - R-openbao-on-hetzner.md
  - R-key-custody-options.md
history:
  - date: "2026-10-19"
    status: mature
    who: okarcz
    note: >
      Decided in a grilling session (Q1–Q19), with the open points answered the same day. No cold
      key; two questions left open.
---

# Decision: OpenBao Transit in a container on the facilitator's server, hot key only

## Conclusion

The facilitator key lives in OpenBao's Transit engine, in its own container on the facilitator's
Hetzner server. The key is generated inside OpenBao and can't be exported. The facilitator only
asks OpenBao for signatures. There is no cold key: the hot key in OpenBao stays the only signer.
[ADR 0013](../../../../../docs/adr/0013-facilitator-key-custody.md) records it.

## Reasoning

1. **The stakes are small.** A leaked key reaches only our own float and the channels' reserves,
   about 180 XLM at launch ([R-key-leak-impact](R-key-leak-impact.md)). A separate OpenBao machine
   (~€78–144 a year) or AWS KMS costs more than that, and the move to Hetzner was about cost.
2. **OpenBao still beats a file secret.** A facilitator bug leaks a revocable, short-lived token,
   not the key, and every signature lands in an audit log.
3. **Root on the server can still copy the key.** That is accepted at these stakes, and the alarms
   (Q8) catch a theft early.

## Decisions

| Q   | Decision |
| --- | -------- |
| 1   | 0048 stays a mainnet blocker. Its cold-key design is declined for now (see Q17) and must be re-checked before mainnet. Channel setup stays hot-signed. |
| 2   | OpenBao unseals with a static seal key passed in as an encrypted systemd credential (`host` mode). TPM mode is recorded as a strong option, not used now. |
| 3   | Fail closed: if OpenBao is down or its audit log is blocked, `/settle` answers an error, `/verify` keeps working, an alarm fires. No fallback copy of the key. |
| 4   | Docker Compose: the facilitator and OpenBao in separate containers, started by a systemd unit that passes in the credentials. |
| 5   | Platform runs OpenBao (0026). Payments owns the signer code, the key policy and the ADR. |
| 6   | OpenBao does Transit signing only. Other secrets stay systemd credentials. |
| 7   | The same setup on testnet and mainnet, with a separate key and policy per network. |
| 8   | Keep both alarms: a fee bump on the fee account that our submitter didn't send (from Horizon), and low balance at 50 XLM. |
| 9   | The facilitator reaches OpenBao only through a unix socket on a volume shared by the two containers. No TCP listener. |
| 10  | AppRole login. Token `token_ttl` 1 h, `token_max_ttl` 24 h, renewed and re-logged-in automatically. The secret ID never expires. Break-in runbook: destroy the secret ID, revoke its tokens, issue a new one. |
| 11  | The audit log goes to a file on its own volume, with rotation and an alarm at 80% disk. |
| 12  | No standing admin access: the root token is revoked after setup and regenerated with the unseal key when needed. Admin is SSH plus the `bao` CLI; no web UI, no remote admin. |
| 13  | One OpenBao per server. Each network gets its own key, policy and AppRole. |
| 14  | Token renewal and re-login live in our Transit `TransactionSigner`, not in an OpenBao Agent container. |
| 15  | The key is generated inside OpenBao, `exportable=false`, on both networks. |
| 16  | Daily encrypted Raft snapshots leave the server. The unseal key is kept offline and apart from them. Fallback if both are lost: new key, new accounts and channels. |
| 16b | Snapshots go to our own sub-account and Borg repo on the company's existing Hetzner Storage Box (BX21), daily, keep 14. |
| 17  | **No cold key** (okarcz: "I dont want to store any cold key. Keep only hot key"). 0048 gets a note to re-check this. |
| 18  | All of it lands in PR #48: ADR 0013, the R- note updates, the threat model, the PR body, and the task changes to 0036, 0026 and 0048. |
| 19  | Build order: Transit signer (0036) against a local OpenBao → OpenBao on testnet (0026), where the current key moves the accounts to the OpenBao key → re-decide 0048 → mainnet. |

## What declining the cold key costs

- **The hot key keeps full power.** Whoever steals it, or a token for it, can drain the fee account
  and the channels' reserves, add a signer and lock us out. The loss is still about 180 XLM plus
  downtime.
- **Losing OpenBao's data loses the accounts.** The key can't be exported (Q15) and nothing else
  signs for the fee account or the channels. The snapshots (Q16) and the unseal key backup are the
  only way back. Without both, the fee account and every channel are lost for good.

## Open

- **Who holds the unseal key backup**, and where. An acceptance criterion of 0047.
- **Where the fee account's top-ups come from** when the 50 XLM alarm fires (Q17b). Options seen: a
  treasury account with an offline key, or top-ups straight from wherever the company buys XLM.

## Alternatives considered

- **OpenBao on its own Cloud machine:** real isolation from root on the facilitator's server, at
  ~€78–144 a year. Rejected at these stakes; the upgrade path when the float or `upto` grows.
- **AWS KMS from Hetzner:** brings AWS back, and adds a cross-cloud call to every settlement.
- **A file secret via systemd credentials:** free, but a facilitator bug can leak the key itself.
- **Shamir unseal:** settlements stop after every restart until people unseal.
- **A cold recovery key (0048 as written):** declined by okarcz on 2026-10-19; re-checked before
  mainnet.
