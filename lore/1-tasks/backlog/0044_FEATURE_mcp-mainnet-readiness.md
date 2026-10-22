---
id: "0044"
title: "Prepare the MCP server for mainnet: assets, networks, payee allowlist, key storage"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0037", "0043"]
tags: [mcp, payments, mainnet, security, priority-medium, effort-large]
links: []
history:
  - date: "2026-10-14"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0037 (W352): what the testnet prototype leaves out on purpose (scope) and what
      must hold before real money (security), collected in its review.
---

# Prepare the MCP server for mainnet: assets, networks, payee allowlist, key storage

## Summary

0037 builds the MCP server as a testnet prototype: one network, one asset. Before it pays with
real money it needs the scope the prototype leaves out and three security guards. Each item below
is decided with the owner (options and a recommendation) before it is built.

## Scope the prototype leaves out

- **Several assets.** The CLI hard-codes testnet USDC (`apps/mcp-local/src/config.ts`); mainnet
  USDC has another contract, and sellers accept others (EURC, XLM).
- **Networks.** Only `stellar:testnet` is registered and the signer is bound to it; mainnet needs a
  configured network and passphrase.
- **RPC URL.** `@x402/stellar` 2.28 requires an RPC URL for mainnet (`getRpcUrl` throws without
  one; testnet has a default). The CLI has no setting for it.
- **Choosing how to pay (W349 A).** Today the library pays the first offer our filter leaves. Add
  an optional `call_paid_http(…, pay_with: {network, asset})` the agent picks from `get_resource`;
  without it, pay the cheapest allowed offer. Limits apply either way.
- **Limits across assets.** Limits are per asset in atomic units; with several assets there is no
  single "at most 10 USD a day". Decide: per-asset limits, or one limit in a reference currency.
- **Tool descriptions** say "on Stellar testnet".

## Must hold before real money

- **Payee allowlist.** Today the agent may pay any `payTo` a catalog or a prompt brings
  (x402-bridge has `MCP_BRIDGE_ALLOWED_PAYTO`). Optional allowlist of payees and/or hosts.
- **Key storage.** The secret key sits in plain text in the MCP client's config file. Options: the
  OS keychain, an external signer, a hardware wallet.
- **Catalog guard.** The catalog request has a time limit but no address guard or size cap (0037,
  "the catalog is trusted as the operator's choice"); a public catalog needs both.
- **Entries the client can't call (from 0053).** Our catalog now lists `http://`, loopback, private
  and `mcp://tool/<name>` resource URLs as sellers send them. `list_resources` shows them and
  `checkUrl` then refuses them as `unsafe_url`. With `STELLAR_X402_ALLOW_INSECURE_LOCAL=1`, an
  agent pointed at a public catalog would call a `localhost` entry on its own machine. Filter or
  mark them in `list_resources`, and say in the README that the flag is for a local catalog only.
- **Threat model entry (from the 0053 review).** `docs/threat-model.md` plans "SSRF in Bazaar
  metadata" but has no catalog entry, and 0053 left the SSRF check on resource URLs to whoever
  fetches them. Write it with the catalog guard: the catalog request, then each listed URL.

## From the comparison with other servers (lore/3-wiki/mcp/x402-mcp-server-comparison.md)

- **Idempotency and "do not resubmit":** agentpay-mcp keeps a settlement history and an
  idempotency key, so a retried call cannot pay twice.
- **A daily limit enforced on chain** by a smart wallet, which a compromised server process cannot
  exceed (agentpay-mcp; its contract enforcement not yet confirmed).
- **A cap on `STELLAR_X402_TIMEOUT_MS`:** today any value is accepted, also one past the MCP
  client's 60 s.

## Acceptance Criteria

- [ ] Each item above has an owner decision recorded here, and the chosen ones are built
- [ ] A paid call on mainnet with a small amount, the transaction hash recorded
