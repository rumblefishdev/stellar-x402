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
| 2 | 0036 adds the signer's variables and AppRole secrets to `deploy/production/compose.yaml`, in the signer's PR, for 0026's owner to review; the channels for the OpenBao key and the move to it stay in 0026 | grilling | beyond it | — | | |
| 3 | One process holds every network's signer, each with its own socket, AppRole, policy and Transit key (0077, PR #93); 0036 configures one network now in that shape | grilling | matches it | — | | |
| 4 | A few seconds after start, the signer signs a fixed 32-byte value (the hash of a constant text, which no transaction has) and checks it against the configured address; `/health` gains a `signer` field (ok, failed, not checked yet), updated by every signature after that. `ready` doesn't change, so the facilitator still starts and answers `/verify` without OpenBao | grilling | changes it (the task had no OpenBao call after start) | — | | |
| 5 | In `openbao` mode, a set `FACILITATOR_SECRET` stops the start with the reason named | grilling | changes it (the task had it ignored) | — | | |
| 6 | `secret` mode is refused on pubnet | grilling | beyond it | ADR 0013: one mechanism on both networks | | |
| 7 | The signer talks to OpenBao with `undici`, already a dependency, over the unix socket; no OpenBao client library (none supports a unix socket and `transit/sign`) | grilling | matches it | OpenBao lists only a Go client | | |
| 8 | Unit tests run against a fake server on a unix socket; tests against a real OpenBao in Docker run when an environment variable is set, in CI on Linux, since a container's socket doesn't reach a macOS host | grilling | matches it | — | | |
| 9 | A failed signature ends the settlement with upstream's reason: `settle_exact_stellar_transaction_signing_failed` for the transaction, `settle_exact_stellar_fee_bump_signing_failed` for the fee bump; nothing is sent, and a counter of signer failures by cause feeds the alarm (0027) | grilling | changes it (the task named no reason) | upstream `@x402/stellar` 2.28.0 `exact/facilitator/index.mjs:185,208` | | |
| 10 | Before each signature, a token with less than 5 minutes left is replaced by logging in again first; the old token keeps working until its own hour ends (a second login doesn't revoke the first, measured on OpenBao 2.7.2), so no signature waits on an expired token. Concurrent signatures share one login; no timer runs in the background, and a `403` isn't retried | grilling | matches it (the task said log in again before expiry) | the AWS SDK refreshes credentials 5 minutes before expiry (`EXPIRATION_MS = 300_000`) | | |
| 11 | A login that fails (wrong secret ID, OpenBao sealed or unreachable) ends that settlement with the signing reason (row 9), logged and counted, and `/health`'s `signer` shows it; the next settlement tries to log in again. No retry loop and no other key | grilling | matches it | ADR 0013: fail closed, no fallback key | | |
| 12 | Every signature is checked against the configured address, through `Transaction.addSignature`, which verifies it; a mismatch ends the settlement before anything is sent | grilling | changes it (the task checked the first signature) | stellar-sdk `transaction_base.js:127-149` | | |
| 13 | One request to OpenBao waits at most 1 s: the slowest measured signature was 286 ms (5 × 2,000 signatures from 20 clients at half a CPU), a settlement's two at most 124 ms (5 × 1,000) | grilling | beyond it | — | | |
| 14 | OpenBao keeps its half-CPU limit: it adds a stall of about 50 ms to at least 1% of settlements (pair p99 44–49 ms in 5 × 1,000), small against a ledger of about 5 s | grilling | beyond it | — | | |

## Not yet decided

- Whether channels are created by a separate funding account, with the OpenBao key only added
  as their signer, so setup needs no Transit signature.

## PR split

| PR | What | State |
|---|---|---|
| — | the Transit signer, its config and its tests | not started |

## Out of scope

- The on-chain limit of the hot key's power (thresholds, a cold key): 0048.
- The fee account as the caller of every settlement, which keeps that limit out of reach: 0093.
  The shape stays two facilitator signatures per settlement, both through this signer.
- The OpenBao container, its unseal, backups and the move of testnet to the key: 0026.

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
  builds upstream's scheme from the Transit signer instead of the secret (`main.ts`).
- **Tests** against OpenBao in Docker (as the spike did): signing, an expired token, OpenBao
  down.
- **Measure** the latency per settlement over the socket.

## Acceptance Criteria

- [ ] Given an OpenBao Transit Ed25519 key, when it signs a testnet settlement through the pool, then the transaction is accepted on chain
- [ ] Given the `openbao` signer mode, when the facilitator starts, then no secret seed is read from the environment or a file
- [ ] Given OpenBao down, when the facilitator starts, then it starts and `/verify` answers
- [ ] Given a configured address that isn't the Transit key's, when the first settlement signs, then it fails closed and nothing is submitted
- [ ] Given a token past its TTL, when the next settlement signs, then the signer has logged in again without a restart
- [ ] Given OpenBao down or sealed, when `/settle` is called, then it answers an error, no other key signs, and the failure is logged and counted
- [ ] The added latency per settlement is measured and recorded
