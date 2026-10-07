---
id: "0028"
title: "Gate harness: external proxy and runner"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0009"]
related_tasks: ["0012"]
tags: [conformance, e2e, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 3.1 (Platform lane)."
---

# Gate harness: external proxy and runner

## Summary

As a reviewer of the grant, I want a reproducible way to run the unmodified x402 e2e suite against our facilitator, so that conformance is shown by evidence, not claimed.

**Story:** [M1 Story 3.1](../../../docs/planning/m1-epics.md#story-31-gate-harness-external-proxy-and-runner) · **Lane:** Platform · **Covers:** FR21 (AD-15)

## Context

- Upstream harness at x402-foundation/x402 `10b2d06`: external proxies live under `e2e/facilitators/external-proxies/` (git-ignored, no upstream example).
- No dependency on `/settle`, so this runs in week 1 alongside the skeleton.

## Implementation

- Proxy folder with config and forwarding script.
- Runner script with the pinned upstream commit.
- Dry run against the public facilitator; record the `upfront` answer in this task and the spine's open questions.

## Acceptance Criteria

- [ ] Given `conformance/external-proxy/`, when it is built, then it has a `test.config.json` (`name`, `type: facilitator`, `language: typescript`, `protocolFamilies: [stellar]`, `schemes: [exact]`, `x402Versions: [2]`, and `environment.required` naming our facilitator-URL variable) and a `run.sh` that listens on `PORT`, prints `Facilitator listening`, answers `GET /health` and `POST /close`, and forwards `/verify`, `/settle` and `/supported`
- [ ] Given a conformance script, when it runs, then it clones `x402-foundation/x402` read-only at a pinned commit, copies in only our proxy folder and runs the Stellar `exact` scenarios with `--output-json`; nothing else in the clone is changed and nothing is pushed upstream
- [ ] Given the proxy pointed at the public Stellar facilitator, when the harness runs, then it completes end to end, which proves the harness before our facilitator is ready
- [ ] Given the `/exact/stellar/upfront` scenario, when this story is done, then what it requires from a Stellar facilitator is answered and written down
