---
title: "Decision: one RDS for PostgreSQL database for all facilitator state"
type: synthesis
status: mature
spawned_from: R-state-store-options.md
spawns: []
tags: [persistence, postgres, decision]
links:
  - R-state-store-options.md
  - ../../../../../docs/adr/0012-facilitator-state-store.md
history:
  - date: "2026-10-12"
    status: mature
    who: akot
    note: "Options scored on the agreed weights; RDS for PostgreSQL chosen, recorded as ADR 0012."
---

# Decision: one RDS for PostgreSQL database for all facilitator state

## Conclusion

The facilitator keeps all four ports and the future T2 search in one **RDS for PostgreSQL**
database, in the same VPC as the ECS service:
- testnet runs db.t4g.micro Single-AZ;
- mainnet runs Multi-AZ, with the class picked before launch.

Recorded in [ADR 0012](../../../../../docs/adr/0012-facilitator-state-store.md). The sources are
in [R-state-store-options](R-state-store-options.md).

## Scoring

Weights were agreed before the research. Each criterion is scored 0–5, then scaled to its weight.

| Criterion (weight) | RDS PG | Aurora PG Serverless v2 | SQLite on EC2 | RDS/Aurora MySQL | DynamoDB |
|---|---|---|---|---|---|
| Correctness for the adapters (25) | 5 | 5 | 5 | 3 | 3 |
| T2 search in the same database (15) | 5 | 4 (extension list not read) | 4 | 2 | 1 |
| More than one instance (10) | 4 | 4 | 0 | 4 | 5 |
| `addHash` latency (10) | 4 | 3 | 5 | 3 | 3 |
| Cost (10) | 4 | 2 | 4 | 4 | 5 |
| Operational load (10) | 3 | 4 | 1 | 3 | 5 |
| Migrations and tests (10) | 5 | 5 | 5 | 4 | 2 |
| Lock-in (10) | 5 | 4 | 5 | 5 | 1 |
| **Total** | **90** | **81** | **77** | **67** | **60** |

Aurora DSQL is cut before scoring: it has no extensions, so it can't hold T2 search.

## Why PostgreSQL wins

- **The contract suites (as of task 0031, 23 cases) pass unchanged on a real server under real
  concurrency**, with no serialization-failure retries.
- **With Aurora PostgreSQL, it's the only family that keeps keyword, fuzzy and vector search in
  one database.** DSQL, MySQL and DynamoDB can't.
- **It fits the ADR 0011 host;** task 0026 adds the subnets and the instance.
- **It's the cheapest managed-database option**, and the closest prior art made the same choice.

## When the runner-up wins

- **Aurora PostgreSQL Serverless v2** if mainnet needs failover under 60 s with less operations
  work, and the budget covers a writer plus a reader. It uses the same adapter, and moving is a
  snapshot restore.
- **SQLite** only if the team gives up both multiple instances and Fargate.

## Strongest argument against

**Availability.** The facilitator refuses to settle while its store is down:
- a Multi-AZ instance still takes minutes of downtime on each engine minor upgrade;
- failover takes 60–120 s.

The design that avoids this is DynamoDB for the hot-path state plus PostgreSQL for the catalog.
It loses only because the team chose a single database. Revisit it if that rule is relaxed.
