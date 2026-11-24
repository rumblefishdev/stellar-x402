---
id: "0042"
title: "Run the MCP CLI in Claude Desktop against our catalog, end to end on testnet"
type: FEATURE
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0037", "0032", "0041", "0063"]
tags: [mcp, dev-tools, e2e, priority-medium, effort-small]
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

- The CLI needs `STELLAR_X402_DISCOVERY_URL`: a server with `GET /discovery/resources`. Since 0032
  our facilitator serves it in public: `https://x402-facilitator.sorobanscan.com`
  (`docs/runbook.md`).
- The catalog must list a seller that still answers. Checked 2026-11-18: the testnet catalog had
  one listing, on a `trycloudflare.com` tunnel that no longer resolves. The run starts by putting
  a seller (`examples/http-api`) on a public URL and getting it listed: since 0063 a settled
  payment to it makes the facilitator read its 402 and write the listing.
- 0037 proved the same flow over MCP stdio with the SDK client and a throwaway one-entry catalog
  (testnet transactions recorded in 0037), not in Claude Desktop.

## Acceptance Criteria

- [ ] Given the locally built `stellar-x402-mcp` CLI and the README's config pointing at our
      catalog (0032), when it is added to Claude Desktop, then an agent lists a resource and pays
      for it end to end on testnet; the transaction hash is recorded here
- [ ] The README's catalog line (`apps/mcp-local/README.md`, today
      `https://your-catalog.example.com`) names our catalog's testnet URL
