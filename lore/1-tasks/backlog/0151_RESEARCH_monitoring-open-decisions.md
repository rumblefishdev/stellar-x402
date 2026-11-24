---
id: "0151"
title: "Settle the monitoring choices 0138 left open, pubnet's first"
type: RESEARCH
status: backlog
milestone: 2
related_adr: ["0011"]
related_tasks: ["0138", "0139"]
tags: [monitoring, alarms, pubnet, priority-medium, effort-small, platform]
links:
  - ../archive/0138_RESEARCH_monitoring-cost-and-grafana-decision/notes/G-alarm-signals-and-triage-runbooks.md
  - ../archive/0138_RESEARCH_monitoring-cost-and-grafana-decision/notes/S-decision-draft.md
history:
  - date: "2026-11-18"
    status: backlog
    who: stkrolikiewicz
    note: "Spawned from 0138 future work."
---

# Settle the monitoring choices 0138 left open, pubnet's first

## Summary

0138's alarm plan entered a default for each design choice it could not settle alone (D1–D30 in
the G- note §6). Going through them with the team, the ones that block pubnet first, turns the
defaults into decisions before 0139 builds on them.

## Context

The G- note §6 lists 20 choices for x402 (the Prices API's went to stellar-prices-api#420): which
causes page by phone on pubnet, the phone route itself (D11, no SNS topic exists today), the
monitoring VM's SNS credentials (D12), the pubnet gate (D21, D22, D30) and others. The decision
draft's "Still open" adds the series count on the CPX12, Alertmanager's `repeat_interval` and the
15 s scrape with a 20 GB retention cap.

## Acceptance Criteria

- [ ] Each of D1–D30 kept in the G- note is decided or deferred, with who agreed
- [ ] The choices that block pubnet (at least D11, D21, D22, D25, D30) are decided first
- [ ] The "Still open" list of the decision draft has an answer or an owner per item
- [ ] What changes 0139's scope is written into 0139
