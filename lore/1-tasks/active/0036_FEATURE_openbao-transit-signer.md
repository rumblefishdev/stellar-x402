---
id: "0036"
title: "OpenBao Transit signer for the facilitator key"
type: FEATURE
status: active
milestone: 1
related_adr: ["0011", "0013"]
related_tasks: ["0014", "0026", "0047", "0048"]
tags: [facilitator, signer-pool, keys, priority-high, effort-small, payments]
links:
  - ../../../docs/adr/0013-facilitator-key-custody.md
  - ../../../packages/signer-pool/src/types.ts
  - ../archive/0047_RESEARCH_hetzner-key-custody/spike/results.md
history:
  - date: "2026-10-09"
    status: backlog
    who: claude
    note: "Spawned from 0014 future work: ADR 0011 moves the mainnet key into AWS KMS after a spike."
  - date: "2026-10-19"
    status: backlog
    who: okarcz
    note: >
      Retargeted by 0047 (ADR 0013): an OpenBao Transit signer on both networks instead of AWS KMS on
      mainnet. Moved from Platform to Payments; first in 0047's build order.
  - date: "2026-10-27"
    status: active
    who: karolkow
    note: >
      Work starts.
---

# OpenBao Transit signer for the facilitator key

## Summary

[ADR 0013](../../../docs/adr/0013-facilitator-key-custody.md) keeps the facilitator key in OpenBao's
Transit engine, in a container on the facilitator's Hetzner server, on testnet and mainnet. This
task adds a `TransactionSigner` that asks OpenBao for each signature, so no secret seed is read by
the facilitator. It is built and tested against a local OpenBao in Docker, before the server exists.

**Lane:** Payments

## Context

- The pool already takes any `TransactionSigner` (`packages/signer-pool/src/types.ts`): an
  `address` and `signTransaction(xdr, { networkPassphrase })`.
- 0047's spike (`spike/results.md`): OpenBao 2.7.1 signs the 32-byte transaction hash with pure
  Ed25519; the signature is `vault:v1:<base64>` of 64 bytes; `stellar-sdk` accepts it; about 6 ms a
  signature locally. A transaction signed only by OpenBao landed on testnet.
- The submitter signs twice per settlement (the inner transaction and the fee bump), so OpenBao's
  latency counts twice.
- ADR 0013's choices this task builds: a unix socket, AppRole with a 1-hour token the signer
  replaces by logging in again, a sign-only policy per network, fail closed.

## Decisions so far

| # | What is done | From | Vs the task | Who does the same (checked) | Code | Test |
|---|---|---|---|---|---|---|
| 1 | The signer is built now, on OpenBao Transit as ADR 0013 has it. OpenBao hides the key from a read-only leak but can't limit what the key signs: on these accounts one signature can pay out the float or change the signers. Limiting that on chain stays 0048's re-check before mainnet | grilling | matches it | upstream's example facilitator keeps the seed in the environment | | |
| 2 | 0036 adds the signer's variables and AppRole secrets to `deploy/production/compose.yaml`, in the signer's PR, for 0026's owner to review; the channels for the OpenBao key and the move to it stay in 0026 | grilling | beyond it | — | `deploy/production/compose.yaml` | `docker compose config` |
| 3 | One process holds every network's signer, each with its own socket, AppRole, policy and Transit key (0077, PR #93); 0036 configures one network now in that shape | grilling | matches it | — | `config.ts` `Config.signer` | `config.test.ts` the signer |
| 4 | Right after start, and again every 30 s (an assumption) while OpenBao is sealed, unreachable, not answering or erring, the signer signs a fixed 32-byte value (the hash of a constant text, which no transaction has) and checks it against the configured address; `/health` gains a `signer` field (ok, failed, not checked yet), updated by every signature after that. `ready` doesn't change, so the facilitator still starts and answers `/verify` without OpenBao | grilling | changes it (the task had no OpenBao call after start) | — | `openbao-signer.ts` `check`; `http/app.ts` `/health` | `openbao-signer.test.ts` checks again while the check fails; `main.test.ts` OpenBao down |
| 5 | A set `FACILITATOR_SECRET` stops the start with the reason named | grilling | changes it (the task had it ignored) | — | `config.ts` | `config.test.ts` refuses a leftover FACILITATOR_SECRET |
| 6 | Dropped by row 22: `secret` mode is refused on pubnet | grilling | beyond it | ADR 0013: one mechanism on both networks | `config.ts` | `config.test.ts` refuses SIGNER=secret on pubnet |
| 7 | The signer talks to OpenBao with `undici`, already a dependency, over the unix socket; no OpenBao client library (none supports a unix socket and `transit/sign`) | grilling | matches it | OpenBao lists only a Go client | `openbao-signer.ts` `post` | `openbao-signer.test.ts` |
| 8 | Unit tests run against a fake server on a unix socket; tests against a real OpenBao in Docker run when an environment variable is set, through a relay from a unix socket to its TCP port, since a container's socket doesn't reach a macOS host; CI runs them too | grilling | matches it | — | — | `openbao-signer.test.ts`, `openbao-signer.openbao.test.ts` |
| 9 | A failed signature ends the settlement with upstream's reason: `settle_exact_stellar_transaction_signing_failed` for the transaction, `settle_exact_stellar_fee_bump_signing_failed` for the fee bump; that envelope isn't sent, and a counter of signer failures by cause feeds the alarm (0027) | grilling | changes it (the task named no reason) | upstream `@x402/stellar` 2.28.0 `exact/facilitator/index.mjs:185,208` | `settle.ts` `reasonFor`; `submitter.ts` `SigningError` | `settle.test.ts` fixed reasons; `settlement-guards.test.ts` |
| 10 | Before each signature, a token with less than 5 minutes left is replaced by logging in again first; the old token keeps working until its own hour ends (a second login doesn't revoke the first, measured on OpenBao 2.7.2), so no signature waits on an expired token. Concurrent signatures share one login; no timer runs in the background, and a `403` isn't retried | grilling | matches it (the task said log in again before expiry) | the AWS SDK refreshes credentials 5 minutes before expiry (`EXPIRATION_MS = 300_000`) | `openbao-signer.ts` `currentToken` | `openbao-signer.test.ts` keeps a token until less than 5 minutes are left; `.openbao.test.ts` expired token |
| 11 | A login that fails (wrong secret ID, OpenBao sealed or unreachable) ends that settlement, also while the old token still has time left with the signing reason (row 9), logged and counted, and `/health`'s `signer` shows it; the next settlement tries to log in again. No retry loop and no other key | grilling | matches it | ADR 0013: fail closed, no fallback key | `openbao-signer.ts` `currentToken` | `openbao-signer.test.ts` fails a signature when a new login fails |
| 12 | Every signature is checked against the configured address, with `Keypair.verify`, as `check()` has no transaction, and `Transaction.addSignature` verifies it again; a mismatch ends the settlement before anything is sent | grilling | changes it (the task checked the first signature) | stellar-sdk `transaction_base.js:127-149` | `openbao-signer.ts` `signatureOf` | `openbao-signer.test.ts` refuses a signature by another key |
| 13 | One request to OpenBao waits at most 1 s: the slowest measured signature was 286 ms (5 × 2,000 signatures from 20 clients at half a CPU), a settlement's two at most 124 ms (5 × 1,000) | grilling | beyond it | — | `openbao-signer.ts` `REQUEST_TIMEOUT_MS` | `openbao-signer.test.ts` gives up on an OpenBao that doesn't answer |
| 14 | OpenBao keeps its half-CPU limit: it adds a stall of about 50 ms to at least 1% of settlements (pair p99 44–49 ms in 5 × 1,000), small against a ledger of about 5 s | grilling | beyond it | — | | |
| 15 | The OpenBao key's fee account and its channels are created and funded by an ordinary wallet outside the project, the same one that tops up the fee float; the OpenBao key is only written into each channel as its sole signer, which the channel's own fresh key signs. The OpenBao key signs nothing but settlements, so no tool signs other transactions through it. `buildCreateChannelsTx` takes the funding account apart from the signer it adds | grilling | changes it (the task's AC 1 assumed channels signed for by the Transit key) | channels funded by a separate account: one peer's provisioning; none adds a facilitator key as signer | `packages/signer-pool/scripts/create-channels.ts` | #100's testnet run |
| 16 | A signer failure (transaction or fee bump) is a "nothing sent" answer: `extra.retryable`, and the identical payload reopens the record, so the payer isn't asked to sign again while the first auth entry can still land. Except after a `txBadSeq`: an earlier envelope was sent and refused, so the record has its hash and doesn't reopen, and the payer waits for the expiration ledger (at most about 5.5 minutes) and signs a new payment. No money moves. Kept because the case is rare and a reopen there costs a change on the money path | grilling | beyond it | task 0073 decision 3; upstream EVM and SVM retry an unsent submission | `settle.ts` `UNSENT_REASONS` | `settle.test.ts` "settles the identical payload once the signer is back"; `settle-pool.test.ts` "answers the sent hash a txBadSeq refused…" |
| 17 | A deploy waits for `signer` ok beside `ready` and `listed`, so an image that can't sign doesn't become the last good one. OpenBao being down rolls a deploy back the same way, and the message says so | grilling | beyond it | — | `deploy/libexec/x402-deploy` | the probe run on 6 `/health` bodies, in the PR |
| 18 | `/verify` doesn't look at the signer. While OpenBao is down the seller's route runs and `/settle` fails: the buyer pays nothing and the seller loses the work. Named in ADR 0013; the protection is 0027's alarm. Refusing would stop every payment after one failed signature, until the next check passes | grilling | beyond it | spec: `/verify` validates the payment (`x402-specification-v2.md:309`), silent on the ability to settle | `docs/adr/0013-facilitator-key-custody.md` | — |
| 19 | A `403` keeps the token: only a restore of an older snapshot, or revoking a token by hand, makes a new login help (measured on OpenBao 2.7.2, 1 run: seal, restart: the token works; the leak procedure: login 400 too). After a restore the facilitator is restarted | grilling | beyond it | — | `docs/adr/0013-facilitator-key-custody.md` | — |
| 20 | One key stays each channel's only signer, as ADR 0003 and AD-12 have it; channels get no keys of their own. Own keys would protect about 30 of about 130 XLM at launch, and nothing against code running in the container. What the key can do stays 0048's re-check | grilling | beyond it | Stellar's channel accounts guide shows a channel with its own key; upstream's `@x402/stellar` takes signers that sign for themselves | `packages/signer-pool/src/setup.ts` | `setup-and-fees.test.ts` |
| 21 | The rule that the key signs only settlements stays, for the theft alarm: any other signature by it is theft, but for the move off a stolen key. OpenBao doesn't enforce the rule, since it signs any hash, so it is no defence against code in the container | grilling | beyond it | — | `docs/adr/0013-facilitator-key-custody.md` | — |
| 22 | The `secret` signer mode goes: the facilitator always signs through OpenBao Transit, and tests and local runs use a fake OpenBao on a unix socket, so one signing path runs everywhere. The real-server tests hold the signer to OpenBao; nothing compares the fake with it. Replaces ADR 0011's "`FACILITATOR_SECRET` stays for local development and tests" and row 6's refusal on pubnet | grilling | changes it (the task had a `secret` mode for local and tests) | upstream's `@x402/stellar` takes any signer object | `apps/facilitator/src/config.ts`; `test/fake-openbao.ts` | `config.test.ts` the signer; `settle-pool.test.ts` |
| 23 | `/health`'s `signer` stays the deploy's gate and can go stale on a server with no payments; the alarm on OpenBao down or sealed comes from 0027's host probe, not from this field. No check runs on a timer after its first pass: an alarm wouldn't reach anyone before the next buyer, and a failed signature already sends nothing and says to repeat the payment | grilling | beyond it | — | `apps/facilitator/src/http/app.ts` | `main.test.ts` |
| 24 | The pubnet gate also names 0027's signer alarm and 0048's re-check of the hot key, so the last task landing can't lift it without them | grilling | beyond it | — | `apps/facilitator/src/config.ts` | `config.test.ts` |
| 25 | A signer failure is logged at `error`, also from the check after start | review | beyond it | — | `openbao-signer.ts` `failed` | — |
| 26 | Compose itself requires `FACILITATOR_ADDRESS_TESTNET` and `CHANNELS_TESTNET`, so a deploy without them stops before it migrates; the database's and the tunnel's units never start the facilitator and set both to `unused`, as they do the image. `x402@.service` decrypts the AppRole files Compose requires | review | beyond it | — | `deploy/production/compose.yaml`, `deploy/systemd` | `docker compose config` per unit, in the PR |
| 27 | The AppRole login comes only from files, on every machine: a plain `OPENBAO_ROLE_ID` or `OPENBAO_SECRET_ID` stops the start. Tests and local runs read two fixture files. `DATABASE_URL` and `RPC_URLS` stay plain locally | review | beyond it | ADR 0013 | `apps/facilitator/src/config.ts` `FILE_ONLY_SETTINGS` | `config.test.ts` refuses a plain OPENBAO_ROLE_ID |

## Not yet decided

Nothing: the grilling's frontier is empty (2026-10-30).

## PR split

| PR | What | State |
|---|---|---|
| A | `buildCreateChannelsTx` with a funding account apart from the signer it adds, and a script that creates channels for a given key (row 15) | #100, merged |
| A′ | the wiring that keeps behaviour: `config.signer` with the secret, the signer passed into `buildSettlement`, `facilitatorAddress`, `verifyOnlySigner` | #106, merged |
| B | the Transit signer, its config, `/health`'s `signer`, the settle reasons, the compose variables and the tests (rows 2–14), stacked on A′ for AC 1 | #102, merged; rows 17–19, 22 and 25–26 too (#116 merged into it) |
| C | the tests that aren't in `test/` or named `.test.ts` move there: five scripts to `test/live/`, `testing.ts` out of `src`; the rule goes into the repo's `CLAUDE.md`; `verifyOnlySigner`'s comment cites the lines that prove it; `keypairSigner`, with no production caller after D, moves to `./testing` | after #102 |
| D | the AppRole login only from files (row 27) | #121, merged |
| E | the comments on a signing failure after a sent envelope (row 16) | #122, merged |

## Out of scope

- The on-chain limit of the hot key's power (thresholds, a cold key): 0048.
- The channel as the caller of a settlement: 0093, merged. A settlement still takes two facilitator
  signatures, both through this signer; a testnet run on that shape is in #102.
- The OpenBao container, its unseal, backups and the move of testnet to the key: 0026.
- The alarm on signer failures: 0027.

## Implementation

- **A Transit `TransactionSigner`** in `apps/facilitator/src/adapters/`, chosen by config:
  - it hashes the transaction for the network, calls `transit/sign/<key>` with the hash and the
    `key_version` from config, decodes `vault:v<n>:<b64>` and adds the signature with the key's hint;
  - its `address` comes from config: the OpenBao key's own account, which is also the fee account
    (the pool pays fee bumps from `signer.address`, `submitter.ts`). The first signature is
    verified against it and the signer fails closed on a mismatch. Startup doesn't call OpenBao,
    and the policy needs no `read` on `transit/keys/<key>`;
  - it talks to OpenBao over a unix socket path from config.
- **AppRole login** in the signer, not an OpenBao Agent: it reads the role ID and secret ID from
  files (Compose secrets), logs in, and logs in again before the token expires. No renewal:
  `token_ttl` and `token_max_ttl` are both 1 h, so a leaked token can't be renewed past the hour.
- **Fail closed:** a signing error makes `/settle` answer an error; there is no fallback key, and
  the error is logged and counted for 0027's alarm. `/verify` doesn't sign, so it is unaffected.
- **Config:** a signer mode (`secret` for local and tests, `openbao` for deployments), the socket
  path, the key name, the key version, the address and the AppRole file paths. In `openbao` mode,
  `FACILITATOR_SECRET` is optional and not read (`config.ts` requires it today), and `/verify`
  builds upstream's scheme from the address alone, since it never signs (`main.ts`).
- **Tests** against OpenBao in Docker (as the spike did): signing, an expired token, OpenBao
  down.
- **Measure** the latency per settlement over the socket.

## Acceptance Criteria

- [x] Given an OpenBao Transit Ed25519 key, when it signs a testnet settlement through the pool, then the transaction is accepted on chain (`a0588081…` on testnet, ledger 5525638, successful on Horizon; run on #102's head `746300b`, not repeated)
- [x] Given the `openbao` signer mode, when the facilitator starts, then no secret seed is read from the environment or a file (`config.test.ts` refuses a leftover `FACILITATOR_SECRET`; `src` holds that name only in the refusal)
- [x] Given OpenBao down, when the facilitator starts, then it starts and `/verify` answers (`main.test.ts`, "starts and serves with OpenBao down")
- [x] Given a configured address that isn't the Transit key's, when the first settlement signs, then it fails closed and nothing is submitted (`settle-pool.test.ts`, "signing with another key", and `openbao-signer.openbao.test.ts` on a real OpenBao)
- [x] Given a token past its TTL, when the next settlement signs, then the signer has logged in again without a restart (`openbao-signer.openbao.test.ts`, "again once its token has expired")
- [x] Given OpenBao down or sealed, when `/settle` is called, then it answers an error, no other key signs, and the failure is logged and counted (`settle-pool.test.ts`, "OpenBao is sealed"; `openbao-signer.test.ts`, `signer_failed` and `signer_failures_total`)
- [x] The added latency per settlement is measured and recorded (two signatures over a unix socket, OpenBao 2.7.2 in Docker at `--cpus=0.5`, 5 × 1,000 pairs: p50 0.60–0.76 ms, p99 44–49 ms, max 124 ms; #102)
