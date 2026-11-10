---
id: "0116"
title: "Full end-to-end suite of the project, with positive and negative paths"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0009"]
related_tasks: ["0029", "0041", "0042", "0046", "0058"]
tags: [tests, e2e, priority-medium, effort-large]
links: []
history:
  - date: "2026-11-06"
    status: backlog
    who: karolkow
    note: "Created from 0029: an end-to-end suite of the whole project, which also brings today's end-to-end and live scripts together."
---

# Full end-to-end suite of the project, with positive and negative paths

## Summary

One end-to-end suite covers every area of the project against a deployed facilitator: payments,
refusals, the catalog, MCP and `upto`. The official x402 suite (0029) checks one good payment per
scenario and no refusal, so it can't stand in for this.

## Context

- Today's end-to-end and live pieces, each run by hand and each in its own shape:
  `apps/mcp-local/e2e`, `apps/facilitator/test/live` (verify, settle, token and spend matrices,
  front-run probe), `packages/signer-pool/test/live`, `contracts/upto-proxy/e2e`, and the gate in
  `conformance/`.
- The live scripts start their own facilitator; none tests refusals through the public URL.
- Related: 0041 (two example integrations), 0042 (MCP in Claude Desktop), 0046 (the MCP e2e
  tidy), 0058 (the upto e2e harness).
- Not for now (the owner, 2026-11-05).

## Implementation

- Decide which of today's pieces the suite takes over, and which stay as they are.
- Positive and negative paths for each area, against the deployed testnet facilitator.

## Acceptance Criteria

- [ ] Each area of the project has a positive and a negative end-to-end path against the deployed testnet facilitator
- [ ] Today's end-to-end and live scripts are either part of the suite or have a stated reason to stay apart
