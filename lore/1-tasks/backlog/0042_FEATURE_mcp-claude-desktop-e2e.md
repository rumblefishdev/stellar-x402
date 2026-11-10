---
id: "0042"
title: "Run the MCP CLI in Claude Desktop against our catalog, end to end on testnet"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0037", "0032", "0041"]
tags: [mcp, discovery, e2e, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-13"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0037: its acceptance criterion on Claude Desktop needs a catalog a README reader
      can point at, and none exists until 0032 serves /discovery/resources.
---

# Run the MCP CLI in Claude Desktop against our catalog, end to end on testnet

## Summary

Add the `stellar-x402-mcp` CLI (0037) to Claude Desktop with the README's config, point it at our
catalog, and have an agent list a resource and pay for it on testnet. Deferred from 0037, whose
code and stdio e2e are done.

## Context

- The CLI needs `STELLAR_X402_DISCOVERY_URL`: a server with `GET /discovery/resources`. Today none
  exists outside tests (0032 is in the backlog; x402.org has no catalog, measured 2026-10-13).
- 0037 proved the same flow over MCP stdio with the SDK client and a throwaway one-entry catalog
  (testnet transactions recorded in 0037), not in Claude Desktop.

## Acceptance Criteria

- [ ] Given the locally built `stellar-x402-mcp` CLI and the README's config pointing at our
      catalog (0032), when it is added to Claude Desktop, then an agent lists a resource and pays
      for it end to end on testnet; the transaction hash is recorded here
- [ ] The README's catalog line names our catalog's testnet URL
