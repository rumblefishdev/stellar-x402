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
  - R-unseal-key-backup.md
history:
  - date: "2026-10-19"
    status: mature
    who: okarcz
    note: >
      Decided in a grilling session (Q1–Q19), with the open points answered the same day. No cold
      key; two questions left open.
  - date: "2026-10-20"
    status: mature
    who: okarcz
    note: >
      Second grilling session (B1–B20): the unseal backup set goes into AWS Secrets Manager, with a
      restore drill; the fee float is 100 XLM with a 25 XLM alarm and manual top-ups. Only the
      mainnet top-up owner is left, before mainnet.
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
| 16  | Daily encrypted Raft snapshots leave the server. The unseal key is kept apart from them (in AWS Secrets Manager since B1). Fallback if both are lost: new key, new accounts and channels. |
| 16b | Snapshots go to our own sub-account and Borg repo on the company's existing Hetzner Storage Box (BX21), daily, keep 14. |
| 17  | **No cold key** (okarcz: "I dont want to store any cold key. Keep only hot key"). 0048 gets a note to re-check this. |
| 18  | All of it lands in PR #48: ADR 0013, the R- note updates, the threat model, the PR body, and the task changes to 0036, 0026 and 0048. |
| 19  | Build order: Transit signer (0036) against a local OpenBao → OpenBao on testnet (0026), where the current key moves the accounts to the OpenBao key → re-decide 0048 → mainnet. |

## What declining the cold key costs

- **The hot key keeps full power.** Whoever steals it, or a token for it, can drain the fee account
  and the channels' reserves, add a signer and lock us out. The loss is still about 130 XLM (B16)
  plus downtime.
- **Losing OpenBao's data loses the accounts.** The key can't be exported (Q15) and nothing else
  signs for the fee account or the channels. The snapshots (Q16) and the unseal key backup are the
  only way back. Without both, the fee account and every channel are lost for good.

## Backup and top-ups (2026-10-20)

Decided by okarcz in a second grilling session, from
[R-unseal-key-backup](R-unseal-key-backup.md) and the fee measurements in ADR 0003 and ADR 0007.
The research recommended a password manager shared by two people; okarcz chose the AWS account the
other projects already run.

### The unseal backup set

| #   | Decision |
| --- | -------- |
| B1  | **AWS Secrets Manager**, not KMS (KMS never gives a key back). 30-day recovery window. |
| B2  | The AWS account soroban-explorer and prices-api share (`750702271865`, `eu-central-1`). |
| B3  | **No AWS credentials on the facilitator's server.** Only people read or write the secret. |
| B4  | **Any admin of that account can read it,** as for the other projects. Default `aws/secretsmanager` key. |
| B5  | **AWS is the only copy.** No paper copy. The AWS account is a recorded dependency, like the Storage Box. |
| B6  | One server runs both networks, so one OpenBao and **one secret**. A second server gets its own. |
| B7  | `bao operator init -recovery-shares=1 -recovery-threshold=1`; the share goes into the secret. |
| B8  | ADR 0013 accepts that AWS admins can read the backup, with the same reasoning as root on the server. |
| B9  | **Restore drill** before mainnet (first on testnet), then quarterly and after any rotation, passphrase change or OpenBao upgrade. Owned by 0026 (Platform). |
| B10 | Name `x402/production/openbao-backup`; tags `Project=stellar-x402`, `Environment=production`. |
| B11 | **CLI only, never CDK** (`/dev/shm`, `create-secret`, `shred`; then `put-secret-value`, old version kept as `AWSPREVIOUS`). Written by the 0026 operator. |
| B12 | One JSON: `seal_key_hex`, `seal_key_id`, `seal_key_sha256`, `previous_seal_key_hex`, `previous_seal_key_id`, `recovery_key`, `borg_passphrase`, `borg_key_export`, `seal_config`, `openbao_version`, `updated`. The runbook lists field names only. |
| B13 | **No alarm on reads now.** The account has no CloudTrail trail; each drill checks the 90-day event history. An alarm is a 0027 follow-up. |

Correction found by the research: with a static seal the root token is regenerated with the
**recovery key**, not the unseal key. ADR 0013 is fixed.

### Fee float and top-ups

| #   | Decision |
| --- | -------- |
| B14 | Testnet: Friendbot by hand, with a one-line script in the 0026 runbook. |
| B15 | Mainnet: a manual withdrawal from the company's exchange account to the fee account. Nothing automatic for now. |
| B16 | **Refill to 100 XLM, alarm at 25 XLM, no upper limit.** Re-check the amount after the first week of mainnet and every week after. Testnet uses the same numbers for now. |
| B17 | The low-balance alarm is a **Slack message**; 0027 decides where the check runs and what the message says. |
| B18 | Who makes the mainnet transfer, and a backup person: **TBD before mainnet** (0026). |
| B19 | The leak limit is **the float plus the channels' reserves** (~130 XLM at 100 XLM). The weekly review checks that this custody still fits the float and raises the upgrade path if not. |
| B20 | The weekly review is owned by okarcz (Payments), recorded in the 0026 runbook. |

What 100 XLM pays for, at a typical `exact` fee of ~41,200 stroops (ADR 0003, measured on testnet):

| Settlements a day | Days until the 25 XLM alarm | Days until empty | Time to act after the alarm |
| ----------------: | --------------------------: | ---------------: | --------------------------: |
| 100               | 182                         | 243              | 61 days                     |
| 500               | 36                          | 49               | 12 days                     |
| 1,000             | 18                          | 24               | 6 days                      |
| 5,000             | 3.6                         | 4.9              | 29 hours                    |
| 10,000            | 1.8                         | 2.4              | 15 hours                    |

At the pool ceiling (250,000 stroops) 100 XLM is 4,000 settlements. Mainnet resource prices may
differ from testnet's, so the first mainnet settlements are checked against these numbers.

## Open

- **Who makes mainnet top-ups,** and a backup person (B18, before mainnet).

## Alternatives considered

- **OpenBao on its own Cloud machine:** real isolation from root on the facilitator's server, at
  ~€78–144 a year. Rejected at these stakes; the upgrade path when the float or `upto` grows.
- **AWS KMS from Hetzner:** brings AWS back, and adds a cross-cloud call to every settlement.
- **A file secret via systemd credentials:** free, but a facilitator bug can leak the key itself.
- **Shamir unseal:** settlements stop after every restart until people unseal.
- **A cold recovery key (0048 as written):** declined by okarcz on 2026-10-19; re-checked before
  mainnet.
