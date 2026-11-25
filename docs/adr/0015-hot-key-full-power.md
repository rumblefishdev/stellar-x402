# ADR 0015: The facilitator key keeps its full power on our accounts, until the stakes grow

- Status: accepted
- Date: 2026-11-24 (task 0048)

## Context

The facilitator key in OpenBao Transit ([ADR 0013](0013-facilitator-key-custody.md)) is the only
signer of the fee account and of every channel (AD-12). Channel setup leaves every threshold at 0
(`packages/signer-pool/src/setup.ts`), so the key's weight of 1 meets low, medium and high on every
account:

- **low:** pay a fee bump, the fee account's only job;
- **medium:** `Payment` and `InvokeHostFunction`, so a settlement from a channel, and a Soroban
  `require_auth` on a G address;
- **high:** add or remove a signer, change a threshold or the master weight, `AccountMerge`.

So whoever holds the key can send the fee account's float away in one `Payment`, add a signer to
every channel and remove ours. ADR 0013 declined a cold recovery key, and asked for this power to be
re-checked before mainnet (task 0048).

What a theft reaches today:

- **About 130 XLM:** the fee account's 100 XLM float and 1.5 XLM of reserve per channel, about
  30 XLM at 20 channels. The key can't move buyers' or sellers' tokens (ADR 0013).
- **Downtime:** a rebuild takes about an hour once the leak is closed. Finding and closing the leak
  takes hours, or days after a break-in on the shared server.
- **Nothing on chain:** `upto-proxy` has no admin and takes its receiver authorizer per payment;
  `exact` names neither the facilitator nor a channel; no contract gives a channel address any power
  (task 0048, Implementation Notes). A new key works for `exact` and `upto` without a redeploy.

A theft and the loss of OpenBao with its backup end the same way: abandon the old accounts and build
new ones under a new key.

The options, compared in
[R-hot-key-reach-without-cold-key](../../lore/1-tasks/active/0048_FEATURE_channel-signer-thresholds/notes/R-hot-key-reach-without-cold-key.md):

- **A, raise the thresholds above the key's weight with no other signer:** the key can only pay fee
  bumps (fee account low 1 / medium 2 / high 2) and settle (channels low 1 / medium 1 / high 2).
- **B0, a 2-of-2:** a second key in AWS KMS, in a separate AWS account, both needed for high.
- **B2, a 2-of-3:** two more online keys in independent places.
- **Keep the full power,** and record when to come back.

## Decision

- **The facilitator key keeps its full power.** Thresholds stay at 0, and the key stays each
  account's only signer, as AD-12 says.
- **We come back to this when either happens first:**
  - the fee account's float plus the channels' reserves pass **500 XLM** (about 4× today's stake);
  - **before `upto` goes to mainnet,** because a stolen key can then charge payers: it is the
    receiver authorizer of every open `upto` authorization in facilitator-delegated mode, and can
    settle each at its full `max_amount` until its `deadline`.

  A and B0 don't answer the `upto` trigger. The receiver authorizer is the fee account, and
  `require_auth` on a G address checks medium (`contracts/upto-proxy/src/lib.rs:136`). With the
  fee account at medium 2, as A and B0 set it, the hot key alone fails that check and
  facilitator-delegated `upto` stops; at medium 1 the hot key still authorizes every open `upto`
  authorization. So that re-check needs its own answer, such as a separate receiver authorizer key
  or short windows.

  The weekly review (ADR 0013) checks the 500 XLM line from the first deploy: the fee account's
  balance plus 1.5 XLM per channel in `CHANNELS`. Task 0133, which readies `upto-proxy` for
  mainnet, carries the `upto` re-check as an acceptance criterion.

- **What a recovery needs is in place before mainnet** (task 0048):
  - a "lost access" section in `docs/runbook.md`: a new Transit key, a new fee account at its
    address, new channels with `create-channels.ts`, the new `FACILITATOR_ADDRESS` and `CHANNELS`
    in the server's `.env`, a restart, the alarms on the new addresses, and when the same server may
    stay (only if the leak didn't come from it);
  - `OPENBAO_KEY` and `OPENBAO_KEY_VERSION` read from the server's `.env` instead of
    `deploy/production/compose.yaml`, so a new key needs no pull request;
  - a timed testnet drill of that section.
- **No contract may take a channel address as an authority,** and `upto`'s
  `extra.receiverAuthorizer` stays the facilitator key, never a channel. A channel is the
  transaction source, so its source-account credentials would satisfy that check, and a stolen key
  keeps medium on abandoned channels forever.

## Rationale

- **The stakes are small and the same under every option.** At launch a theft costs about 130 XLM
  and an hour of rebuild under the status quo. Under A the thief still burns the float on fee bumps,
  only slower, and the reserves are stranded either way.
- **A costs more than it saves.** It can't be undone: nothing can ever change those accounts again,
  so every planned rotation abandons them, and a later move to B needs new accounts.
- **B0 and B2 cost real work before mainnet** for a stake this size: an untested Ed25519 path on
  AWS KMS, a tool that collects two signatures, runbooks and drills. B2 adds a third place to run.
  The exception to ADR 0013 (OpenBao signing a rotation, not only settlements) isn't B0's alone: a
  planned rotation under the status quo needs it too (Consequences).
- **What protects us is the rebuild, not the signer layout.** A working OpenBao backup (ADR 0013,
  task 0026), the "lost access" runbook and a drill keep both a theft and a loss to about an hour.
- **The trigger keeps the decision honest.** The float has no upper limit, and 300 channels hold
  450 XLM of reserves alone. `upto` changes who loses: payers, not only us.

## Alternatives considered

- **A, thresholds above the key's weight:** removes the one-shot drain and the lockout, but saves
  little money, can't be undone, and turns every rotation into abandoning the accounts.
- **B0, 2-of-2 with an AWS KMS key in a separate account:** fixes a theft in place with no loss, and
  can grow into B2 without new accounts. Losing either key freezes changes, as in A. The first
  candidate when the trigger fires, if its conditions hold: the server holds no credentials for the
  KMS account, that account is apart from the one holding OpenBao's backup, and KMS Ed25519 signs a
  Stellar transaction on testnet. It answers the 500 XLM trigger, not the `upto` one (Decision).
- **B2, 2-of-3 online keys:** fixes a theft and a loss in place, for the most infrastructure.
- **B1, one recovery key at weight 2 in KMS:** that key alone can take everything, so it is a single
  key again.
- **Pre-authorized transactions, hash(x) signers, sponsorship, SEP-30, Soroban contract accounts:**
  fragile, a weaker cold key, no control, a draft for user wallets, or impossible as a transaction
  or fee source. Details in the research note.

## Consequences

- **A stolen key can lock us out of every channel** and take the float. The theft alarm (ADR 0013)
  catches it; we rebuild under a new key and abandon the old accounts.
- **Losing OpenBao's data and its backup** ends the same way. Until task 0026's snapshot setup runs,
  OpenBao has no backup, so this risk is open now.
- **A planned rotation keeps the channels, not the fee account.** ADR 0013's runbook covers only a
  suspected theft: the old key adds the new one on every channel and removes itself, and merges the
  fee account into the new key's own account, since the fee account is always the key's own
  account. A planned rotation follows the same steps, so it needs what that runbook needs: ADR
  0013's exception to "the OpenBao key signs settlements only", and the tool that builds the
  transaction (task 0099), which isn't built yet.
- **AD-12 and `checkChannel` stay as they are.** The key is each channel's only signer, with the
  master weight at 0.
- **Abandoned accounts stay under a stolen key forever.** Nothing may trust their addresses.

## References

- [ADR 0013](0013-facilitator-key-custody.md): key custody, the theft alarm, the weekly review
- [M1 architecture spine](../architecture/m1-spine.md): AD-12
- [Threat model](../threat-model.md): "Facilitator key", "Receiver authorizer key"
- Task 0048 (`lore/1-tasks/active/0048_FEATURE_channel-signer-thresholds/`): the decisions, the
  contract check, and the research note with every option and its sources
