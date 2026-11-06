---
id: "0117"
title: "Decide how the RPC URL list is kept, so its order can be seen and reviewed"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0011", "0013"]
related_tasks: ["0026", "0029", "0045", "0077"]
tags: [facilitator, deploy, rpc, priority-medium, effort-medium, payments]
links:
  - ../../../docs/runbook.md
  - ../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-06"
    status: backlog
    who: okarcz
    note: "Raised while measuring Karol's RPC order question (0029 decision 8) from the server; okarcz parks it for M2."
---

# Decide how the RPC URL list is kept, so its order can be seen and reviewed

## Summary

As the team running the facilitator, we want to see which RPC URLs each network uses and in what
order, and to change them through a reviewed pull request, without putting an RPC provider's API
key in our public repo.

## Context

- Today `RPC_URLS` is a systemd credential on the server, encrypted with the host key: one file per
  version, `rpc-urls.<network>.<date>.cred`, and a symlink naming the active one (ADR 0011,
  runbook, Credentials). `x402-creds` decrypts it at the unit's start, Compose mounts it, and the
  facilitator reads it once at startup through `RPC_URLS_FILE` (`apps/facilitator/src/config.ts`).
  The order is the priority: `RPC_URLS[0]` is where calls start and where the probe brings them
  back (spine AD-3).
- It is a credential on purpose: an RPC URL can carry an API key, mainnet will likely use a keyed
  provider, and the repo is public. A key pushed to git stays in its history, forks and caches, so
  a leak means rotating it with the provider. ADR 0013 also keeps testnet and mainnet on the same
  setup.
- What this costs today:
  - nobody sees the current order without decrypting the file on the server;
  - a change goes through no pull request, so there is no review and no reason in the history,
    only a runbook step and a note in 0026;
  - mapping an old log line's `RPC_URLS[i]#<fingerprint>` back to its URL needs the old `.cred`
    files.
- Found on 2026-11-06, when Karol asked to put gateway.fm first on testnet (0029 decision 8).
  Measured from `ch-prod-01`, 25 `getLatestLedger` calls each: SDF median 2.67 s (p90 4.09 s,
  max 4.31 s), gateway.fm median 0.12 s (p90 0.15 s, max 0.23 s), all 200, the same ledger. Whether
  and when to swap the order belongs to 0029, not to this task.
- With 0077 each network has its own list, so whatever is chosen covers both.

## Options

1. **An encrypted file in the repo** (SOPS with age, or ansible-vault), decrypted by the playbook.
   Pull requests and history, but the ciphertext stays public for good, a new key needs guarding,
   and the diff can't show a reviewer that the order changed.
2. **URLs in the repo, only the key secret**, e.g. `https://provider.example/${RPC_KEY_1}`, filled
   in at startup. The order and providers are readable in a pull request and testnet needs no
   secret; it needs code (placeholders, a startup check that none is left, logs still without the
   filled URL), and providers put a key in the path, the query or a header.
3. **The repo names a secret in AWS Secrets Manager**, which the playbook fetches into the `.cred`.
   A pattern we already use, with versions and CloudTrail, but a pull request shows only the name.
4. **No change to how it runs, plus a register of versions** in the runbook or 0026 (date, URLs
   with any key masked, fingerprints). Visible and no new mechanism, but nothing keeps the register
   in step with the server.

Whatever is chosen, a change through `develop`, `deploy/production` and a second person's approval
is slow when an RPC fails at night, so a manual swap on the server may need to stay as the
emergency path.

## Acceptance Criteria

- [ ] The team has chosen an option (or another), and ADR 0011 records it with the reason
- [ ] Given the chosen way, when someone wants to know a network's RPC URLs and their order, then
      they can read it without decrypting a file on the server, and no API key is in the repo
- [ ] Given a change to the list, when it is made, then it is reviewed and its reason is kept, and
      an emergency swap on the server is still possible (runbook)
- [ ] Given a log line's `RPC_URLS[i]#<fingerprint>` from any past version, when it is looked up,
      then it maps back to its URL
