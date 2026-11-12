---
id: "0135"
title: "Labelled query set and nDCG@10 run for the Bazaar search"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0008"]
related_tasks: ["0120", "0134", "0132"]
tags: [bazaar, search, evaluation, priority-high, effort-medium, discovery]
links:
  - ../../../docs/scf/milestone-1-evidence.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan. The Panel Review response (§4) promises this
      evaluation; no task held it.
---

# Labelled query set and nDCG@10 run for the Bazaar search

## Summary

As the team shipping ranked search (0120), we want a fixed, human-labelled query set and a script
that scores the ranking against it, so we can show the ranking is good enough before it replaces
curated order.

## Context

- The Panel Review response (§4) commits to:
  - the metric nDCG@10;
  - 50 natural-language queries against a seeded catalog of 25 test resources, HTTP endpoints and
    MCP tools mixed;
  - every query-result pair graded 0–3 by the team **before** any ranking code is evaluated
    against it;
  - a threshold of nDCG@10 ≥ 0.75 before the ranking ships beyond curation-only mode; below it,
    curated order is used;
  - a re-run at every milestone boundary, then monthly for 6 months after launch.
- The M1 evidence says the evaluation starts with the ranking it measures.

## Implementation Plan

- Seed data: 25 test resources as catalog entries, committed.
- 50 queries and their grades, committed before the ranking of 0120 is run against them; the
  commit order is the proof.
- A script that loads the seed, runs each query through `/discovery/search` and prints nDCG@10
  per query and overall.
- The result for the Tranche #2 boundary, recorded for 0132.

## Acceptance Criteria

- [ ] 25 seeded resources (HTTP and MCP) and 50 queries with 0–3 grades are in the repo
- [ ] Given the repo history, when it is read, then the grades were committed before the ranking
      was first scored against them
- [ ] Given a running facilitator with the seed, when the script runs, then it prints nDCG@10 per
      query and overall, with one command
- [ ] The Tranche #2 result is recorded with the commit of the query set and of the ranking
- [ ] Given a result under 0.75, when search ships, then it uses curated order, and the task says so
