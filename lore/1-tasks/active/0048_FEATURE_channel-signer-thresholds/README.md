---
id: "0048"
title: "Before mainnet, decide again how far the hot key's power reaches"
type: FEATURE
status: active
owner: okarcz
milestone: 2
related_adr: ["0003", "0005", "0011", "0013", "0015"]
related_tasks: ["0047", "0007", "0016", "0020", "0026", "0027"]
tags: [signer-pool, keys, security, mainnet, priority-high, effort-medium, payments]
links:
  - ../../../../docs/architecture/m1-spine.md
  - ../../../../docs/threat-model.md
history:
  - date: "2026-10-15"
    status: backlog
    who: claude
    note: >
      Spawned from 0047's research (okarcz asked for it): channel setup leaves every threshold at
      0, so the facilitator key alone can change signers on every channel.
  - date: "2026-10-19"
    status: backlog
    who: okarcz
    note: >
      0047 (ADR 0013) declined the cold recovery key for now: keep only the hot key. Still a mainnet
      blocker; re-check this design before mainnet.
  - date: "2026-10-28"
    status: backlog
    who: okarcz
    note: >
      Reframed as the pre-mainnet re-check: ADR 0013 declined the cold key, so the design
      below is one of three options, not the plan. The criteria apply only if the re-check picks it.
  - date: "2026-11-02"
    status: backlog
    who: okarcz
    note: "Moved to M2: a re-check before mainnet, which comes after 0036 and 0026, and mainnet is outside T1's scope."
  - date: "2026-11-23"
    status: active
    who: okarcz
    note: "Started with the re-check: a cold recovery key, another way to keep the hot key below high, or the hot key's full power accepted."
---

# Before mainnet, decide again how far the hot key's power reaches

## Summary

Every channel is set up with the facilitator key at weight 1, the master key at 0 and **every
threshold left at 0** (`packages/signer-pool/src/setup.ts`, the `setOptions` in channel setup).
Weight 1 then meets the high threshold, so whoever holds the facilitator key can add a signer,
raise the thresholds and lock us out of every channel at once. Losing the key (a deleted KMS key,
a lost OpenBao cluster) freezes every channel for good, since even `AccountMerge` needs high.
Set thresholds so the hot key can settle but not change signers, and add a cold recovery signer
that can. This holds whichever custody option 0047 picks, and is a mainnet blocker.

> **Re-check before mainnet** (okarcz, 2026-10-19): 0047 decided on OpenBao Transit with **no cold
> key**; only the hot key is kept ([ADR 0013](../../../../docs/adr/0013-facilitator-key-custody.md)).
> The design below needs a cold key, so it is on hold. Before mainnet, decide again: a cold
> recovery key, another way to keep the hot key below high, or accept the hot key's full power and
> record why. What declining it costs: a stolen key can lock us out of every channel, and losing
> OpenBao's data and its unseal key loses the fee account and every channel. Build order (0047):
> 0036 → 0026 on testnet → this re-check → mainnet. The testnet move to the OpenBao key is signed by
> the current key, in 0026, not cold-signed.

**Lane:** Payments

## Context

- Changing signers or thresholds and `AccountMerge` need the high threshold; Invoke Host Function
  and Payment need medium; a fee bump needs only the fee account's low threshold. Since 0093 the
  channel is the caller, so the fee account no longer needs medium for `exact`. Other steps still
  need its thresholds: creating channels (medium, `setup.ts`) and merging it in ADR 0013's rotation
  and theft steps (high). So raising them above the hot key's weight on a real account needs a
  second signer or rewritten runbooks first: with no second signer, nothing can change that account.
- AD-12 today requires the facilitator key to be each channel's **only** signer, and
  `checkChannel` flags any other signer as `extra-signer` and checks only medium. Both change.
- Each extra signer adds 0.5 XLM of reserve per account, unless a cold account sponsors it.
- A classic transaction holds up to 100 operations, so one cold signature can add or swap the hot
  key on many channels at once.
- Option 2 (no cold key), checked on Stellar, Ethereum and Solana:
  [R-hot-key-reach-without-cold-key](notes/R-hot-key-reach-without-cold-key.md).
- Details and sources: 0047's report (`reports/Hetzner signer key custody.md`, on branch
  `lore-0047-hetzner-key-custody`), section "Stellar thresholds, not the custody product, decide
  the blast radius".

## Implementation

- **Channels:** hot key weight 1, cold recovery key weight 2, thresholds low 1 / medium 1 /
  high 2, set by channel setup. Add the recovery signer before raising high, in one `SetOptions`
  sequence, so the account is never locked.
- **The facilitator's own account** (pays fee bumps): master (hot) key weight 1, thresholds
  low 1 / medium 2 / high 2, the cold key at high or above. The hot key can fee-bump but can't
  send a Payment.
- **`checkChannel`:** facilitator weight ≥ max(low, medium) and < high, the recovery key ≥ high,
  no other signer.
- **Migration** for existing channels (testnet), cold-signed and batched.
- **Reserve:** fund the extra 0.5 XLM per channel, or sponsor it from a cold account; decide.
- **Rotation runbook:** add the new hot key with the cold key, switch the facilitator, remove the
  old key (0026's runbook).
- **Amend spine AD-12** and the threat model.

## Acceptance Criteria

The re-check comes first: a cold recovery key, another way to keep the hot key below high, or
the hot key's full power accepted, with the reason recorded in an ADR. The criteria below apply
only to the cold-key option.

- [x] Before mainnet, one of the three options is chosen and recorded (full power kept, ADR 0015)
- [ ] Given a new channel, when setup runs, then its thresholds are low 1 / medium 1 / high 2 and the facilitator key (weight 1) can't change its signers or merge it, while a settlement still lands
- [ ] Given the facilitator's own account, when it is hardened, then the hot key can sign fee bumps but not a Payment or a signer change
- [ ] Given the cold recovery key, when the hot key is lost or rotated, then one batched, cold-signed transaction moves many channels to a new hot key, tested on testnet
- [ ] Given a channel without the recovery signer or with the hot key at high, when `checkChannel` runs at startup, then the service refuses to start
- [ ] Spine AD-12 and the threat model describe the new signer layout; the reserve choice is recorded

**Criteria for the chosen option** (accept full power, 2026-11-24; the cold-key criteria above
no longer apply):

- [x] ADR 0015 records that the hot key keeps its full power, why (about 130 XLM at stake,
      rebuilt in about an hour), and the trigger: float + reserves above 500 XLM, or before `upto`
      goes to mainnet, whichever comes first; ADR 0013 and AD-12 link to it
- [x] The threat model lists the `upto` risk: a stolen key settles open payments at their full
      `max_amount`
- [x] No contract gives a channel address any power: `upto-proxy` and every other contract
      checked, the result recorded (Implementation Notes, 2026-11-24)
- [ ] `OPENBAO_KEY` and `OPENBAO_KEY_VERSION` are read from the server's `.env`, not
      `deploy/production/compose.yaml`, so a new key needs no PR
      Closes once the production server's `.env` holds both names, the playbook has copied this
      `compose.yaml`, and `x402@` has started from it with `signer: ok`. `x402-deploy` never copies
      `compose.yaml`, so a deploy before that playbook run proves nothing about `.env`.
- [x] `docs/runbook.md` has a "lost access" section: new key, fee account, channels, `.env`,
      restart, alarms, and when the same server may stay
      (2026-11-24, "Lost access to the facilitator's accounts"; step 3's OpenBao commands are
      unproven until the drill)
- [ ] A testnet drill moves the facilitator to a new key, fee account and channels with that
      section, timed, and the result recorded

## Implementation Notes

**Channel addresses hold no power in any contract** (checked 2026-11-24, commit `49e656ef`'s
tree). Abandoned channels keep a stolen key at medium, which is what a G address's
`require_auth` checks in Soroban, and since 0093 a channel is the settlement's caller. So a
contract that named a channel as an authority would hand a thief that power forever.

- `upto-proxy` (`contracts/upto-proxy/src/lib.rs`), the only contract we deploy for production:
  - it asks for exactly two authorizations, `from.require_auth_for_args` (`:123`) and
    `receiver_authorizer.require_auth()` (`:136`), both addresses named in the client's signed
    arguments; it never reads the invoker;
  - the spender of the client's `approve` is the proxy itself (`:161-163`), not the caller;
  - it stores nothing but its instance TTL (`:168`), has no admin and no upgrade path (`:5-8`);
  - in facilitator-delegated mode `receiver_authorizer` is the key the facilitator publishes in
    `/supported` (`contracts/upto-proxy/README.md:347-348`), which is `FACILITATOR_ADDRESS`
    (`apps/facilitator/src/http/supported.ts:13`), not a channel.
- `exact` calls the token's own `transfer` with the payer's `ADDRESS` credentials; the token
  checks only `from`.
- `test-token`, `hostile-token` and `test-wallet` are test fixtures. `deploy-contract.sh`
  deploys `upto-proxy` and `test-token` to testnet only (`deploy/scripts/deploy-contract.sh:15`),
  and `test-token` checks only `from` and `spender` (`contracts/test-token/src/lib.rs:117-155`).
- **Rule for later work:** `extra.receiverAuthorizer` must stay the facilitator key and never a
  channel, and no contract may take a channel address as an authority. A channel is the
  transaction source, so a contract asking for a channel's `require_auth` would be satisfied by
  the channel's source-account credentials, which a stolen key still controls.

**Local rehearsal of "Lost access" (2026-11-24).** A real OpenBao 2.7.2 from a copy of
`deploy/openbao` (own volume names, the socket on the host), the facilitator from source on the
local PostgreSQL and the public testnet RPCs, 2 channels instead of 20. Key v1 with its fee account
`GBVJ2B6C…BSWY` and channels ran with `signer: ok`; then steps 1–6:

- **Step 3** (rotate, `min_encryption_version`, revoke the AppRole's tokens, destroy its secret
  IDs, a new secret ID): every command worked as written. Checked after it: a token taken with the
  old secret ID answers 403, the old secret ID can't log in (400), signing with version 1 is refused
  ("requested version for signing is less than the minimum encryption key version"), and the new
  secret ID signs with version 2.
- **Steps 4–6:** a new fee account `GAX4LGRF…UVGM` and 2 channels, the facilitator on version 2:
  `ready`, `listed`, `signer: ok`, and `/supported` lists the new address.
- **Time:** 62 s of commands for steps 1–6 (step 3: 2 s, step 4: 13 s), without typing, decisions
  or step 7. A real run adds the root token, 20 channels in 2 transactions, the server's `.env`
  and the Watch deploy.
- **Fixed in the runbook from it:** `rotate` and `config` print the whole key (now `>/dev/null`);
  a version below `min_encryption_version` shows as `signer_failed` reason `error` (OpenBao's 500),
  not `address_mismatch` or `denied`.
- **Not covered locally:** systemd, `x402@`, the server's `.env`, `systemd-creds`, a paid request,
  and step 7. The timed drill on the production server covers them after #235 is deployed.

## Design Decisions

### From Plan

1. **Accept the hot key's full power** (okarcz, 2026-11-24, stkrolikiewicz's proposal): no
   threshold change and no second key. At launch scale every option loses about the same on a
   theft (about 130 XLM, rebuilt in about an hour); A gives up in-place rotation for little, and
   B0 costs a KMS spike, a signing CLI and an ADR 0013 exception before mainnet. Options in
   [R-hot-key-reach-without-cold-key](notes/R-hot-key-reach-without-cold-key.md).
2. **Trigger to revisit: float + reserves above 500 XLM, or before `upto` reaches mainnet**,
   whichever comes first (okarcz, 2026-11-24). 500 XLM is about 4× today's stake; `upto` puts
   payers' money at risk, not only ours.
3. **A new ADR 0015**, linked from ADR 0013 and AD-12, rather than amending 0013 (okarcz,
   2026-11-24): when the trigger fires, a later ADR supersedes 0015 without rewriting 0013.
   AD-12's signer layout doesn't change.
4. **All gaps close in 0048** (okarcz, 2026-11-24): the ADR, the threat-model entry, the
   channel-address check, the key name moved to `.env`, the "lost access" runbook and its testnet
   drill. OpenBao's backup stays with 0026.

### Emerged

5. **The key's name and version move to the server's `.env`** (okarcz, 2026-11-24), as
   `OPENBAO_KEY_TESTNET` and `OPENBAO_KEY_VERSION_TESTNET` next to `FACILITATOR_ADDRESS_TESTNET`
   and `CHANNELS_TESTNET`, required by `deploy/production/compose.yaml`.
   - **Why:** after a theft OpenBao usually survives with the old key in it, so the new key gets a
     new name or version 2. With the name in `compose.yaml`, the rebuild waits for an approved pull
     request and a playbook run, which can take hours at night, while ADR 0015 counts on about an
     hour. In `.env`, a rebuild under a new version of the same key (`transit/keys/stellar-testnet/
     rotate`) is: write four values, restart. A new name also needs a new policy in OpenBao, since
     the AppRole's policy names the key (`transit/sign/stellar-testnet`, `docs/runbook.md`, OpenBao
     step 4); that is still no pull request, so the "lost access" runbook keeps the name and bumps
     the version.
   - **No new risk:** only someone with access to the server can edit `.env`, and that person can
     already change `FACILITATOR_ADDRESS` and `CHANNELS` the same way, and reach OpenBao. A wrong
     key name doesn't stop the facilitator at startup: `checkChannels` compares only
     `FACILITATOR_ADDRESS` with each channel (`apps/facilitator/src/main.ts:548`), and the OpenBao
     check isn't awaited (`:563`). After `x402-deploy`, its probe requires `/health`'s `signer` to
     be `ok` and goes back to `digest.good` otherwise (`deploy/libexec/x402-deploy:63`). After a
     plain restart, the facilitator runs with `signer: failed` and every settle fails until the
     value is fixed, which `signer_failed` in the log shows. What goes is the review of a change
     to the name, which gave no protection the server access doesn't already bypass.
   - **Also:** the four values that describe the key and its accounts always change together, so
     they now live in one place instead of split between the repo and the server.
   - **Rollout:** a server set up before this has only the address and the channels in `.env`. Add
     the two new lines before the playbook run that copies this `compose.yaml`: from that copy on,
     any start of `x402@` (a deploy, a crash, a reboot) stops at interpolation without them
     (`docs/runbook.md`, "Before the first deploy"). The playbook checks it: on a server whose
     `.env` exists, it stops before copying the compose files unless all four names are there
     (code review, D1).

6. **Stan's review of #234, #235 and #238, all 12 points accepted** (okarcz, 2026-11-25):
   - **#234:** A and B0 don't answer the `upto` trigger: they set the fee account, the receiver
     authorizer, to medium 2, which `require_auth` checks, so `upto` stops; at medium 1 nothing
     changes for it. ADR 0015 says so, and the `upto` re-check is an acceptance criterion of 0133.
     ADR 0013's weekly review checks the 500 XLM line from the first deploy. A planned rotation
     under the status quo keeps only the channels and needs ADR 0013's exception and 0099's tool,
     as B0 does. The research note's "a few hours" is now "about an hour, to be confirmed by the
     drill", and the threat model's B0 is the 2-of-2.
   - **#235:** the playbook reads `.env` the way Compose does (`export`, leading blanks, an empty
     value counts as missing). The runbook's `.env` template takes the key's name and version as
     placeholders, and `channel-quarantined` edits only the `CHANNELS_TESTNET` line, so a channel
     repair after a rebuild doesn't reset the version to 1. The `.env` criterion closes on a start
     after the playbook copied the new `compose.yaml`.
   - **#238:** a credential seen outside the server can't sign (OpenBao has no network), so it is
     not this section unless the audit log shows a signature the facilitator didn't make, which
     means someone was on the server. The OpenBao-disk row updates the backup secret with
     `put-secret-value` and sets up the snapshots' AppRole again. Step 7 redeploys the Alarms
     stack as well as Watch. Step 6 says what to do when a malformed version or a wrong address
     stops the start.

## Open Gaps

Found on 2026-11-24 while walking through a theft of the hot key with today's setup
([R-hot-key-reach-without-cold-key](notes/R-hot-key-reach-without-cold-key.md), "Theft with
today's setup"). Each one holds whichever option the re-check picks.

- **OpenBao's backup doesn't run yet.** `snapshot_age_seconds` on `x402-host` reads 1e9 (no
  snapshot ever succeeded), and steps 3–5 of the runbook's "OpenBao snapshots → Setting it up"
  never ran. Until they do, losing OpenBao's data loses the key for good. Owned by 0026.
- ~~**No runbook for "we lost access".**~~ Written 2026-11-24 (`docs/runbook.md`, "Lost access to
  the facilitator's accounts"); the drill is still open. ADR 0013's theft steps assume our key still works on the
  accounts (it adds the new key and merges the old fee account). When a thief has removed our
  key, nothing covers it: a new key, fee account and channels, the config switch, the alarms, and
  the rule that the same server stays only if the leak didn't come from it. Needs its own steps
  and a testnet drill. stkrolikiewicz's steps in the research note are most of it. ~~The key's
  name and version are hardcoded in `compose.yaml`, so a new key needs an approved PR.~~ Moved to
  the server's `.env` on 2026-11-24 (decision 5).
- ~~**`upto` is missing from the threat model.**~~ Added 2026-11-24 ("Facilitator key", "A stolen key charges open `upto` authorizations"). A stolen key is `receiver_authorizer` on every open
  `upto` payment and can settle each at its full `max_amount` until its `deadline`. The money goes
  to the seller, but the payer pays more. Record it before `upto` reaches mainnet.
- ~~**Confirm nothing trusts a channel address.**~~ Checked 2026-11-24: nothing does
  (Implementation Notes). The rule stays for any later contract.
