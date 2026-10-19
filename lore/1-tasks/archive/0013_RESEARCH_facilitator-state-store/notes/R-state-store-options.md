---
title: "State store: requirements and options"
type: research
status: mature
spawned_from: README.md
spawns: [S-state-store-decision.md]
tags: [persistence, postgres, dynamodb, sqlite, aws]
links:
  - ../../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-10-12"
    status: mature
    who: akot
    note: "Requirements per kind of state, six options checked against them, with a local spike of the two architectures."
---

# State store: requirements and options

All prices are eu-central-1 on-demand, read on 2026-10-12. The team agreed on **one database** for
all state, T2 search included.

## Requirements

The ports in `apps/facilitator/src/ports/` are the contract, and `test/port-contracts.ts` checks it.
The app passes `now` into every call, so the store never uses its own clock.

| State | Consistency | Durability | T1 (testnet, one task) | Mainnet (maybe 2+ tasks) |
|---|---|---|---|---|
| Settlement record and channel lease | Atomic claim on `network:payer:nonce`. Forward-only CAS where one caller wins. A hash is readable right after `addHash`. The lease is exclusive. | Must survive restart and deploy; a lost record is a payment that may still land | `addHash` is awaited before every send, so its latency adds to each settlement | Same, across tasks. Up to ~100 settlements per ledger (ADR 0003), each a handful of writes |
| Catalog | Idempotent upsert by key, ordered by `ledger`. Stable insertion order. Filters, `limit`/`offset`, `total` | Must survive restart | Small. Read by `/discovery/resources` | T2 adds search and ranking on the same data |
| Rate-limit counters | Atomic fixed-window count | Loss is tolerable | One task | Shared across tasks |
| Spend budgets | All-or-nothing reserve against several rolling windows, idempotent by id. Amounts are int64 stroops | Must survive restart; losing reservations would reopen spent budget | Global, payer, `payTo` and asset scopes | Same, across tasks |

Retention isn't fixed yet. Settlement records must outlive the auth-entry expiry and the
startup re-check. Old rate-limit windows and spend reservations past the longest window can be
pruned.

## Options

**RDS for PostgreSQL**
- **Ports:**
  - Each operation is one statement or one short Read Committed transaction.
  - Read Committed re-checks an `UPDATE`'s `WHERE` on the latest row version, so a CAS has one winner. `ON CONFLICT DO UPDATE` ends in an insert or an update unless its `WHERE` excludes the row ([PostgreSQL docs](https://www.postgresql.org/docs/current/transaction-iso.html)).
  - The spend reserve must stay at Read Committed with sorted `FOR UPDATE` on per-scope rows. At Repeatable Read the same design can overspend (PostgreSQL docs; reproduced on 18.6).
- **Search:**
  - Core full-text search, plus pg_trgm 1.6 and pgvector 0.8.2 on RDS 17/18.
  - 18.6 is the latest GA ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html)).
- **Cost** ([AWS price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/eu-central-1/index.json)):
  - db.t4g.micro Single-AZ: $0.019/h, about **$16.6/mo** with 20 GB gp3.
  - db.t4g.small Multi-AZ: $0.074/h, about **$59.5/mo**.
- **Ops:**
  - Multi-AZ instance failover typically takes 60–120 s ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html)).
  - A minor upgrade takes the primary and the standby down together for several minutes ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.PostgreSQL.html)).
  - The Micro class is outside the RDS SLA ([AWS](https://aws.amazon.com/rds/sla/)).
- **Driver:** `pg` 8.23.1 (2026-09-30). It returns int8 as a string, so stroops need a type parser.

**Aurora PostgreSQL Serverless v2**
- **Ports and search:** the same engine and adapter as RDS.
- **Cost:**
  - It never pauses while a connection is open, and the lease heartbeat keeps one open.
  - A resume takes about 15 s ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)).
  - So the real floor is 0.5 ACU, about $51/mo. The Frankfurt price of $0.14/ACU-h has one source.
- **Failover:** under 60 s with a reader, up to ~10 min without one ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html)).

**Aurora DSQL**
- **Concurrency:** optimistic. Conflicts fail at commit with 40001 ([AWS](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-concurrency-control.html)).
- **SQL support:** it now has `ON CONFLICT`, foreign keys and identity columns.
- **No extensions**, so no pgvector and no pg_trgm ([AWS](https://aws.amazon.com/blogs/database/dsql-sql-dialect-how-amazon-aurora-dsql-differs-from-single-instance-postgresql)). Indexes are B-tree only.
- **Fails the one-database gate on T2 search.**

**RDS or Aurora MySQL**
- **Cost:** the same prices as PostgreSQL.
- **Ports:** no `RETURNING`, so operations take more round trips.
- **Search:**
  - Vector distance functions are HeatWave-only ([MySQL](https://dev.mysql.com/doc/refman/9.3/en/vector-functions.html)), leaving FULLTEXT only.
  - Fails T2 if T2 needs semantic or fuzzy search.

**DynamoDB**
- **Fits cleanly:** claim, CAS, the lease and the counters are each one conditional write.
- **Hash lookup:**
  - A GSI is eventually consistent only ([AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)).
  - So the hash needs its own item, written in a transaction with the record. Each item in a transaction costs 2 write units ([AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)).
- **Awkward:**
  - The multi-budget reserve fits one transaction, but the global scope is a hot key.
  - Catalog paging with `total` and insertion order reads the whole index.
- **Search:** native search is vector-only (ANN, equality filters, indexed asynchronously), with no keyword ranking ([AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/VectorSearch.html)). Keyword search would need OpenSearch, a second store.
- **Cost and availability:**
  - Cheapest: a few $/mo at testnet volume.
  - No maintenance windows, and a 99.99% SLA ([AWS](https://aws.amazon.com/dynamodb/sla/)).
- **Testing:** DynamoDB Local 3.3.1 never throws transaction conflicts.

**SQLite on EC2 with EBS**
- **Ports and search:** every operation is one `BEGIN IMMEDIATE`, and FTS5 with bm25 covers search ([sqlite.org](https://www.sqlite.org/fts5.html)).
- **One writer on one host.** WAL doesn't work over a network filesystem, which rules out EFS ([sqlite.org](https://www.sqlite.org/wal.html)).
- **Not Fargate:**
  - An ECS-managed EBS volume on Fargate is new for each task and deleted when a service task stops ([AWS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html)).
  - So staying on Fargate means restoring from Litestream on every boot. Otherwise the service moves to EC2 (t4g.small, about $17/mo).
- **Mainnet:** loses multiple instances.

## Local spike (server PostgreSQL vs embedded SQLite)

Throwaway adapters ran the contract suites as of task 0031 (23 cases), unchanged. Aurora shares
the PostgreSQL adapter, so it wasn't spiked separately. The code isn't committed.

| | PostgreSQL 18.6 (`pg` 8.23.1, 20-connection pool) | SQLite 3.53.2 (better-sqlite3, WAL, `synchronous=FULL`) |
|---|---|---|
| Contract cases | 23/23 | 23/23 (concurrency passes by construction: one connection) |
| Adapter size | ~410 lines | ~380 lines |
| `addHash` p50 / p99, local, macOS full flush (F_FULLFSYNC) | 3.95 / 5.12 ms | 3.01 / 5.59 ms |

- **The concurrency test catches a missing lock.** With the scope lock removed from the reserve
  (at Read Committed), the contract's concurrent-reservation case failed 3 runs out of 3.
- **Default macOS settings flush far less** (PostgreSQL 0.15 / 0.30 ms), so they understate a real
  disk.
- **The cloud latency is unmeasured.** The only Multi-AZ figure, +2–5 ms, is from 2017
  ([AWS](https://aws.amazon.com/blogs/database/amazon-rds-under-the-hood-multi-az/)).

## Prior art

- **Upstream keeps nothing durable.** The coinbase/x402 facilitators dedupe in memory, and the
  Stellar `exact` one writes no hash before broadcast ([coinbase/x402](https://github.com/coinbase/x402)).
- **The closest Stellar facilitator, openx402, uses PostgreSQL.**
  ([migrations](https://github.com/Ithaca-Labs/openx402/tree/main/facilitator/migrations)):
  - an idempotency table with an `unknown` state;
  - channel row leases carrying a fencing token that guarded writes check;
  - a fee-usage table;
  - migrations under a transaction-level advisory lock.
- **Leases need fencing tokens.** Without one, a paused holder can still write after its lease
  is gone ([Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)).
- **Session advisory locks pin RDS Proxy connections; transaction-level ones don't**
  ([AWS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html)).
