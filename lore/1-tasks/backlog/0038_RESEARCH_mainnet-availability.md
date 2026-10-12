---
id: "0038"
title: "Decide the mainnet availability setup: two tasks with separate channel sets, and a WAF"
type: RESEARCH
status: backlog
related_adr: ["0011"]
related_tasks: ["0014", "0025", "0026", "0027"]
tags: [facilitator, mainnet, availability, deploy, priority-low, effort-medium, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-10-12"
    status: backlog
    who: claude
    note: "Spawned from 0014 future work: ADR 0011 leaves the two-task option and the WAF rule to the mainnet launch."
---

# Decide the mainnet availability setup: two tasks with separate channel sets, and a WAF

## Summary

ADR 0011 runs one facilitator task per network. Every restart is therefore a few minutes of
downtime, whatever causes it: a deploy, AWS task retirement, a host or zone failure, a crash,
an out-of-memory kill, or a flood that starves the task. The ADR records two tasks with separate
channel sets in two Availability Zones as an option for mainnet, not a requirement. This task
decides, before the mainnet launch, whether to take that option and whether to add a WAF
rate-based rule.

## Context

- **The model** is in task 0014's `R-cloud-container-options` §A2:
  - one ECS service with `desiredCount` 2 and `minimumHealthyPercent` 50;
  - each task takes a free channel set's lease at start;
  - a deploy replaces the tasks one at a time, so there is no downtime, only half the channels
    for a few minutes.
- **It changes AD-17**, which today gives one process the network's one channel set. The lease
  from 0025 would become one lease per channel set.
- **It costs** a second task (about $33/mo at 1 vCPU / 2 GB) and a second channel set (1.5 XLM
  reserve per channel).
- **The WAF rule** (about $5 per web ACL plus $1 per rule and per-request fees) limits floods at
  the edge. The in-app limits (AD-11, AD-18) only act once a request has reached the task.
- Related tasks: 0014, 0025, 0026, 0027.

## Implementation

- Weigh the mainnet uptime target (99%, `docs/monitoring.md`) against the measured downtime of a
  testnet deploy and of a task replacement.
- If two tasks are chosen:
  - change AD-17 in the spine;
  - extend the 0025 lease to channel sets;
  - add the second set to the config and the CDK service;
  - run a deploy on testnet with two tasks while payments flow.
- Decide the WAF rule and its limits.

## Acceptance Criteria

- [ ] Given the mainnet uptime target and the testnet measurements, when the decision is made,
      then ADR 0011 (or a new ADR) records whether mainnet runs two tasks and a WAF rule, and
      why
- [ ] Given two tasks are chosen, when a new version is deployed on testnet with payments
      flowing, then no `/settle` fails for lack of a serving task, and each task settles only
      through its own channel set
