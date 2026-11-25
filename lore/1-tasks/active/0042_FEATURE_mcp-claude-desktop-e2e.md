---
id: "0042"
title: "A seller that always answers in the testnet catalog, found and paid from Claude Desktop"
type: FEATURE
status: active
owner: bstruzyk
milestone: 2
related_adr: []
related_tasks: ["0037", "0032", "0041", "0063", "0137", "0026", "0044", "0069"]
tags: [mcp, dev-tools, e2e, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-13"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0037: its acceptance criterion on Claude Desktop needs a catalog a README reader
      can point at, and none exists until 0032 serves /discovery/resources.
  - date: "2026-11-25"
    status: active
    who: bstruzyk
    note: >
      Started: first put examples/http-api on a public URL and get it listed in the testnet
      catalog, then run the CLI in Claude Desktop against it.
  - date: "2026-11-25"
    status: active
    who: karolkow
    note: >
      Replanned: the run must work for any README reader on any day, so the seller stays up on our
      server instead of a tunnel; the agent searches (0137) instead of listing.
---

# A seller that always answers in the testnet catalog, found and paid from Claude Desktop

## Summary

Give the public testnet catalog a seller that always answers, so a reader who adds the
`stellar-x402-mcp` CLI (0037) to Claude Desktop with the README's config can search our catalog and
pay, any day.

## Context

- The CLI needs `STELLAR_X402_DISCOVERY_URL`: since 0032 our facilitator serves the catalog in
  public, `https://x402-facilitator.sorobanscan.com` (`docs/runbook.md`).
- Checked 2026-11-25: the testnet catalog holds one listing, on a `trycloudflare.com` tunnel that no
  longer resolves, and no pubnet listing. A seller run from a laptop leaves the same dead listing
  when it stops, so the seller runs on our server.
- Testnet has no outside sellers: the sellers 0155 seeds are on pubnet, and the CLI pays only on
  testnet until 0044. A demo seller on pubnet and seeding come with 0044.
- `examples/http-api` reads only `SELLER_ADDRESS` (a public account), `FACILITATOR_URL` and `PORT`,
  so the server holds no secret for it. `FACILITATOR_URL` defaults to x402.org and must name ours,
  or the payment never reaches our catalog. It has no Dockerfile yet.
- The server's tunnel is managed in Cloudflare (`--token-file`), so the seller's hostname is added
  there by whoever holds the zone; the server's owner reviews and deploys (0026).
- The seller needs no rate limit of its own: the facilitator limits `/verify` per client
  (`apps/facilitator/README.md`, `RATE_LIMIT_VERIFY`).
- 0037 proved list then pay over MCP stdio, and 0137 search then pay, both with the SDK client; this
  task is the same path in Claude Desktop against the deployed catalog.
- Dead listings are removed by 0069, not here.

## Acceptance Criteria

- [ ] `examples/http-api` runs on the production server next to the facilitator, at its own public
      https hostname, settling through our facilitator, and is listed in the testnet catalog
- [ ] The README's catalog line (`apps/mcp-local/README.md`, today
      `https://your-catalog.example.com`) names our catalog's testnet URL
- [ ] Given the README's config in Claude Desktop, when an agent searches the catalog, then it finds
      that seller and pays it on testnet; the transaction hash is recorded here
- [ ] The seller is covered by the facilitator's health check or an equivalent one: it answers 402
