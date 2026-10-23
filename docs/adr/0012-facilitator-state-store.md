# ADR 0012: Keep all facilitator state in one RDS for PostgreSQL database

- Status: accepted
- Date: 2026-10-12, amended 2026-10-20 (task 0022: pools for `reserve` and the rate limiter; 0026 measures; hosting note)

## Context

All facilitator state goes through four ports that `apps/facilitator` owns (AD-7):

| Port              | What it holds                                                 |
| ----------------- | ------------------------------------------------------------- |
| `SettlementStore` | settlement records and the channel lease (AD-6, AD-16, AD-17) |
| `CatalogStore`    | the Bazaar catalog (AD-19, AD-20)                             |
| `RateLimitStore`  | fixed-window counters (AD-11)                                 |
| `SpendStore`      | fee budgets and breakers (AD-18)                              |

`test/port-contracts.ts` checks every adapter against the same suites, including concurrent claims,
transitions and reservations. `addHash` is awaited before every send, so its write latency adds to
each settlement.

The team agreed on **one database** for all of it, including the search and ranking that the
catalog gets in Tranche 2 (T2). [ADR 0011](0011-facilitator-hosting.md) puts the facilitator on ECS
Fargate in eu-central-1:

- one ECS task per network;
- stop-before-start deploys;
- no NAT gateway;
- secrets in SSM Parameter Store.

## Decision

- **Store.**
  - One RDS for PostgreSQL 18 instance per network, in isolated private subnets (no NAT) of the
    ECS VPC.
  - Only the security groups of the service and the migration task can reach it.
  - Storage is encrypted, deletion protection is on, and automated backups allow point-in-time
    restore.
  - Testnet: db.t4g.micro Single-AZ with gp3 storage.
  - Mainnet: a Multi-AZ DB instance. The class, burstable or not, is priced and chosen before
    launch.
  - Auto minor version upgrade is off on mainnet. Upgrades go through Blue/Green in a planned
    window.
- **Access.**
  - The `pg` driver, small fixed pools per ECS task, and no RDS Proxy: 10 connections, plus 3 for
    `reserve` and 3 for the rate limiter, so reservations queued on the global scope's lock, or a
    flood's hits on its key's row lock, can't starve the other stores.
  - TLS with the RDS CA bundle.
  - The database credentials are an SSM Parameter Store SecureString under `/x402/<network>/db`,
    injected like `FACILITATOR_SECRET`.
  - `STORE=memory|postgres` picks the adapters in the composition root.
- **Schema.**
  - Plain SQL migrations, applied by one command, under a transaction-level advisory lock with a
    `lock_timeout`.
  - Deploys run the migrations as a one-off ECS task before the service update.
  - Every change is expand/contract: new columns are nullable or have a default, and nothing is
    dropped or renamed in the same release. The old ECS task keeps serving while the migration
    runs.
- **Adapter rules.**
  - Every time comes from the app's `now`; SQL never calls `now()`.
  - Every transaction is Read Committed. At Repeatable Read, the spend reserve's scope locks don't
    prevent overspend.
  - The channel lease is a row, never a session advisory lock.
  - Stroops are `bigint`, converted to `BigInt` column by column.
  - The schema and the statement for each operation are in
    [G-postgres-port-mapping](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/notes/G-postgres-port-mapping.md).
- **Search (T2).** It can use the same database: core full-text search, `pg_trgm` and `pgvector`.

## Rationale

- **The contracts map to documented guarantees.**
  - Under Read Committed, an `UPDATE`'s condition is re-checked on the latest row, so a
    compare-and-set has one winner.
  - `ON CONFLICT DO UPDATE` ends in an insert or an update, unless its `WHERE` excludes the row.
  - A local spike ran the contract suites as of task 0031 (23 cases, including the ledger-ordered
    catalog upsert) unchanged on PostgreSQL 18.6 with a 20-connection pool. All 23 passed, with no
    serialization-failure retries. Connection loss is handled separately (see Consequences).
- **With Aurora PostgreSQL, it is the only family that keeps keyword, fuzzy and vector search in one
  database.** Full-text, trigram and vector search are all on RDS for PostgreSQL 17 and 18. DSQL,
  MySQL and DynamoDB can't do all three.
- **It is the cheapest managed database that fits ADR 0011.**
  - Testnet, db.t4g.micro Single-AZ with 20 GB: about $17 per month.
  - Mainnet, Multi-AZ db.t4g.small: about $60 per month.
- **Prior art agrees.** The closest open-source Stellar facilitator keeps its idempotency records,
  channel leases and fee usage in PostgreSQL.

## Alternatives considered

- **Aurora PostgreSQL Serverless v2.**
  - It never pauses while a connection is open, and the lease keeps one open. Compute alone costs
    about $51 per month per network (0.5 ACU at a single-source $0.14/ACU-h), plus storage and I/O.
  - Failover under 60 s needs a reader.
  - It is the runner-up for mainnet: it uses the same adapters, and moving to it is a snapshot
    restore.
- **A Multi-AZ DB cluster.** It fails over in about 35 s and upgrades by failover. Its smallest class
  is c6gd.medium, three instances. It is priced along with the mainnet class.
- **Aurora DSQL.** No extensions (so no `pgvector` or `pg_trgm`) and B-tree indexes only. It can't
  hold T2 search. Rejected.
- **DynamoDB.**
  - Claim, compare-and-set, lease and counters are clean conditional writes. It is the cheapest
    option and has no maintenance windows.
  - Hash lookup needs a second item written in a transaction, because GSIs are eventually
    consistent. Catalog paging with a total reads the whole index. Keyword search would need
    OpenSearch, a second store.
  - Rejected under the one-database rule.
- **RDS or Aurora MySQL.** The same price, but no `RETURNING`, and no vector distance outside
  HeatWave. Rejected.
- **SQLite with a persistent volume.**
  - Fargate's EBS volumes are per ECS task and are deleted when the task stops.
  - EFS is a network filesystem, and SQLite's WAL doesn't support those.
  - So it would mean EC2 or a restore on every boot, plus a single writer on mainnet. Rejected.
- **Redis or Valkey for the rate-limit counters.** A second store, outside the one-database rule.
  Rejected.
- **DynamoDB for the hot path and PostgreSQL for the catalog.**
  - Better availability for settlements: a 99.99% SLA and no maintenance windows.
  - But it is two stores, which the team ruled out. Revisit it if that rule changes.

## Consequences

- **Availability is the main cost.**
  - The facilitator refuses `/settle` while the database is down.
  - A Multi-AZ failover takes 60–120 s, and a minor upgrade takes minutes. RDS can still force a
    minor upgrade for a security fix or an end of support.
  - The `pg` client needs connect, query and statement timeouts, TCP keepalive, eviction of broken
    connections and `idle_in_transaction_session_timeout`.
  - A failover drill on testnet and the upgrade policy go into the runbook.
- **A lost commit acknowledgement can hit any write.** The caller re-reads with `get` before acting,
  and never broadcasts on an unknown outcome (tasks 0009 and 0019).
- **One clock per comparison, but several across ECS tasks.** The lease TTL carries a skew margin
  (task 0025), and window reads tolerate a bounded skew.
- **Throughput.**
  - `reserve` takes about six round trips plus one per budget, and holds the global scope's row
    lock, so reservations are serialized across ECS tasks.
  - A window's sum reads only that window's rows. Each scope row carries its reservation's time
    and amount, indexed `(scope, at) INCLUDE (amount)`, so the sum is an index-only scan and never
    reads `spend_reservations` (task 0050).
  - Every process runs a pruner (task 0050):
    - spend reservations go after twice the window or 7 days, whichever is longer;
    - rate-limit windows go one window after they end;
    - deletes run in batches, 1 s per table each minute, and skip locked rows.
  - A migration that rewrites these tables while they hold weeks of traffic needs an online
    runner: batched backfill, `CREATE INDEX CONCURRENTLY`, lock retries. The one-transaction
    runner hit the 10 s statement timeout at about 200 000 reservations (task 0050).
  - Task 0026 measures the full settle path and `addHash` on the testnet instance it creates;
    0022 had no instance to measure on.
- **Task 0022 builds the adapters.** CI runs the contract suites against a PostgreSQL service
  container.
- **Two contract questions remain for the team:**
  - a fencing token on `ChannelLease`, so a stale holder's writes are rejected (task 0025);
  - `addHash` with a hash another settlement already has. Keying hashes by hash makes "reject" the
    natural answer (task 0022).
- **Rate limiting.** Task 0023 puts in-process counters in front of the database ones, so abuse
  doesn't turn into database writes.
- **Additions to ADR 0011, built by task 0026:**
  - isolated private subnets for RDS;
  - the instance, its security group and its parameter group;
  - the credentials parameter;
  - the migration task in the deploy workflow;
  - the failover drill.
- **Hosting is being revised** (ADR 0011 in PR #24, task 0039): one facilitator and one PostgreSQL
  container per network on the company Hetzner server, stop-before-start deploys, and backups (a
  daily base backup and a WAL archive off the server) run by the team. The RDS items above change
  with it. What was built for several ECS tasks (the lease, separate pools, skew margins) stays
  correct for one process, so running several instances is an option kept open, not a decision.
- **Exit.** The ports are the seam. Moving to Aurora PostgreSQL is a snapshot restore. Moving to
  another store means new adapters that pass the same suites, once task 0022 has closed the gaps
  listed in G.

## References

- [Task 0013](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/README.md):
  [options and sources](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/notes/R-state-store-options.md),
  [decision](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/notes/S-state-store-decision.md),
  [PostgreSQL mapping](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/notes/G-postgres-port-mapping.md)
- [M1 architecture spine](../architecture/m1-spine.md): AD-6, AD-7, AD-11, AD-16 to AD-20
- [ADR 0006](0006-settlement-record.md), [ADR 0007](0007-fee-abuse-containment.md),
  [ADR 0008](0008-bazaar-catalog-integrity.md), [ADR 0011](0011-facilitator-hosting.md)
