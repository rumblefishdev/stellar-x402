---
id: "0036"
title: "OpenBao Transit signer for the facilitator key"
type: FEATURE
status: backlog
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
