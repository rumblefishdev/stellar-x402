# ADR 0012: Keep all facilitator state in one PostgreSQL database

- Status: accepted
- Date: 2026-10-12, amended 2026-10-20 (task 0022: pools for `reserve` and the rate limiter; 0026
  measures; hosting note; task 0039: PostgreSQL in a container on the Hetzner server) and
  2026-10-21 (task 0039: how backups leave the server, the migration service and its bounds) and
  2026-10-22 (task 0039: pgBackRest; migrations before the old facilitator stops) and 2026-10-26
  (task 0032: a pool for listings; task 0064: no memory store, tests run on PostgreSQL) and
  2026-10-27 (task 0067: online migrations)

## Context

All facilitator state goes through four ports that `apps/facilitator` owns (AD-7):

| Port              | What it holds                                                 |
| ----------------- | ------------------------------------------------------------- |
| `SettlementStore` | settlement records and the channel lease (AD-6, AD-16, AD-17) |
| `CatalogStore`    | the Bazaar catalog (AD-19, AD-20)                             |
| `RateLimitStore`  | fixed-window counters (AD-11)                                 |
| `SpendStore`      | fee budgets and breakers (AD-18)                              |

`test/port-contracts.ts` checks the adapters against the same suites, including concurrent claims,
transitions and reservations. `addHash` is awaited before every send, so its write latency adds to
each settlement.

The team agreed on **one database** for all of it, including the search and ranking that the
catalog gets in Tranche 2 (T2). [ADR 0011](0011-facilitator-hosting.md) puts the facilitator on the
company Hetzner server under Docker Compose:

- one facilitator container per network;
- stop-before-start deploys;
- secrets as encrypted systemd credentials, passed to Compose.

The first version of this ADR assumed ECS Fargate and RDS; it is in git history.

## Decision

- **Store.**
  - One PostgreSQL 18 container per network on the same server (ADR 0011), pinned by digest,
    with a 1 GiB memory limit and its data on a volume. It has a systemd unit of its own, so a
    facilitator deploy never restarts it.
  - Only that network's facilitator and the migration service reach it, over the `internal`
    network `x402-<network>-db`.
  - Backups: pgBackRest pushes each WAL segment as it closes, compressed and encrypted, and takes
    a daily backup, to our own sub-account on the company's existing Hetzner Storage Box over
    SFTP, kept 14 days (ADR 0011). They allow point-in-time restore and lose about a minute. An
    alarm fires when archiving fails, since `pg_wal` then grows on a disk ClickHouse shares. An S3
    bucket in the company AWS account is the fallback. A restore drill, with `pgbackrest check`
    and `verify`, runs on testnet before mainnet.
  - The volume isn't encrypted at rest, and nothing here relies on disk encryption. The database
    holds mostly what the chain already shows (transaction hashes, payer addresses, amounts)
    plus budgets and limits, never keys; the secrets are encrypted on their own (systemd
    credentials, OpenBao's seal, pgBackRest's repository); and only root on the server reaches
    the volume, who reaches everything else anyway. LUKS, if the disks have it, is an extra
    layer, not a requirement. The 14 days of backups off the server stand in for RDS's deletion
    protection.
  - Minor upgrades are a digest bump in a planned window; a major upgrade is planned on its own.
- **Access.**
  - The `pg` driver and small fixed pools per process: 10 connections, plus 3 for
    `reserve`, 3 for the rate limiter and 3 for `/discovery/resources` listings, so reservations
    queued on the global scope's lock, a flood's hits on its key's row lock, or a burst of public
    listings can't starve the other stores. 19 connections per process. The listings' pool has a
    2 s statement timeout instead of 10 s, so a few slow listings hold it only briefly.
  - No TLS: the connection stays on one host's internal Docker network (ADR 0011). Passwords use
    `scram-sha-256`. TLS comes back if the database leaves the host.
  - The database password is an encrypted systemd credential, mounted as a Compose `file:`
    secret; the app reads its URL from a file (`DATABASE_URL_FILE`, 0026), never from
    `environment:`.
  - Every store is PostgreSQL, in tests and local runs too: a second, in-memory implementation
    passed what PostgreSQL refused (a NUL in a `/settle` body, 0009). Each test file takes its
    own schema in the repo's compose database or `TEST_DATABASE_URL` (task 0064).
- **Schema.**
  - Plain SQL migrations, applied by one command, under a session advisory lock per schema that
    the runner polls for: a session blocked in `pg_advisory_lock` would hold a snapshot that
    `CREATE INDEX CONCURRENTLY` waits for (task 0067).
  - Deploys run the migrations as a one-off service of the new image while the old facilitator
    still serves, before it stops (ADR 0011). A failed migration fails the deploy, and the old
    facilitator keeps serving.
  - A migration is transactional if, on the largest database it will meet, its group holds
    write-blocking locks for under 500 ms until it commits, so a `reserve` queued behind it stays
    well under its 2 s; otherwise it is online (task 0067):
    - the group's 10 s statement bound only stops a run gone wrong: a group that holds
      `spend_reservation_scopes` for 8 s fails every `reserve` queued on it, at its 2 s lock
      timeout;
    - consecutive transactional migrations run in one transaction, so a failed group leaves the
      schema as it was;
    - an online migration is a list of steps, each non-blocking or holding its lock for at
      most 1 s: a single catalog-only `ALTER`, a keyset backfill batch,
      `CREATE INDEX CONCURRENTLY`, `NOT VALID` then `VALIDATE`. A backfilled column's new rows
      take a default set in an earlier step when the value is a constant, or a trigger when it
      is computed from the row; otherwise rows the previous release writes keep the default. Each step commits with a
      `name#<i>` marker in `schema_migrations`, so a failed or killed run leaves a valid expand
      prefix that the next deploy finishes. The previous release works after every step, and a
      migration that has started anywhere is never edited.
    - With expand/contract, that is what makes migrating before the stop, and a deploy's
      automatic rollback, safe.
  - The migration service's bounds, by kind: a transactional group 10 s; an online `ALTER` waits
    at most 500 ms for its lock, a quarter of `reserve`'s 2 s, retries `55P03` and `40P01`, and
    runs at most 1 s, which leaves a `reserve` queued behind it 500 ms for the step's `COMMIT`; a backfill batch 5 s, 5 000 rows, 250 ms apart, and it retries its
    statement timeout too, since a batch that ran out of time waited on the disk; an index build or
    `VALIDATE` waits for locks without a timeout, since a `lock_timeout` aborts the build, and
    runs at most 30 minutes. The runner's session sets `client_connection_check_interval`, so a
    run whose client died releases its lock within seconds. Long steps run in the deploy
    (ADR 0011).
  - Every change is expand/contract: new columns are nullable or have a default, and nothing is
    dropped or renamed in the same release, so a rollback to an earlier image runs against the
    newer schema.
- **Adapter rules.**
  - Every time comes from the app's `now`; SQL never calls `now()`.
  - Every transaction is Read Committed. At Repeatable Read, the spend reserve's scope locks don't
    prevent overspend.
  - The channel lease is a row, never a session advisory lock.
  - Stroops are `bigint`, converted to `BigInt` column by column.
  - The schema and the statement for each operation are in
    [G-postgres-port-mapping](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/notes/G-postgres-port-mapping.md).
- **Search (T2).** It can use the same database: core full-text search, `pg_trgm` and `pgvector`.
  The official `postgres` image has no `pgvector`, so T2 needs an image that does.

## Rationale

- **The contracts map to documented guarantees.**
  - Under Read Committed, an `UPDATE`'s condition is re-checked on the latest row, so a
    compare-and-set has one winner.
  - `ON CONFLICT DO UPDATE` ends in an insert or an update, unless its `WHERE` excludes the row.
  - A local spike ran the contract suites as of task 0031 (23 cases, including the ledger-ordered
    catalog upsert) unchanged on PostgreSQL 18.6 with a 20-connection pool. All 23 passed, with no
    serialization-failure retries. Connection loss is handled separately (see Consequences).
- **It keeps keyword, fuzzy and vector search in one database.** PostgreSQL 17 and 18 have
  full-text and trigram search, and vector search through `pgvector`. DSQL, MySQL and DynamoDB
  can't do all three.
- **It costs nothing extra on the server:** about 1 GiB of RAM, and under 1 GB of disk on testnet
  (ADR 0011). Managed RDS was about $17 a month on testnet and $60 on mainnet.
- **Prior art agrees.** The closest open-source Stellar facilitator keeps its idempotency records,
  channel leases and fee usage in PostgreSQL.

## Alternatives considered

The managed AWS options were weighed while hosting was on AWS. They stay the path if the store
moves back there.

- **Aurora PostgreSQL Serverless v2.**
  - It never pauses while a connection is open, and the lease keeps one open. Compute alone costs
    about $51 per month per network (0.5 ACU at a single-source $0.14/ACU-h), plus storage and I/O.
  - Failover under 60 s needs a reader.
  - It would use the same adapters, and moving to it is a dump and restore. Whether mainnet needs
    a managed store is part of 0038.
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
  - On Fargate, EBS volumes were per ECS task and deleted when the task stopped. On the Hetzner
    server a volume persists, so that reason is gone.
  - Still rejected: one writing process closes the option of several instances, and T2's keyword
    and fuzzy search are PostgreSQL's strength.
- **Redis or Valkey for the rate-limit counters.** A second store, outside the one-database rule.
  Rejected.
- **DynamoDB for the hot path and PostgreSQL for the catalog.**
  - Better availability for settlements: a 99.99% SLA and no maintenance windows.
  - But it is two stores, which the team ruled out. Revisit it if that rule changes.

## Consequences

- **Availability is the main cost.**
  - The facilitator refuses `/settle` while the database is down.
  - There is no failover on one server: a restart of the container or the server, and every
    PostgreSQL upgrade, takes the store down. Mainnet's answer is 0038.
  - The `pg` client needs connect, query and statement timeouts, TCP keepalive, eviction of broken
    connections and `idle_in_transaction_session_timeout`.
  - A restore drill on testnet and the upgrade policy go into the runbook.
- **A lost commit acknowledgement can hit any write.** The caller re-reads with `get` before acting,
  and never broadcasts on an unknown outcome (tasks 0009 and 0019).
- **One clock per comparison, but several across processes.** The lease TTL carries a skew margin
  (task 0025), and window reads tolerate a bounded skew.
- **Throughput.**
  - `reserve` takes about six round trips plus one per budget, and holds the global scope's row
    lock, so reservations are serialized across processes.
  - A window's sum reads only that window's rows. Each scope row carries its reservation's time
    and amount, indexed `(scope, at) INCLUDE (amount)`, so the sum is an index range scan that
    never reads `spend_reservations` (task 0050).
  - Every process runs a pruner (task 0050):
    - spend reservations go after twice the window or 7 days, whichever is longer;
    - rate-limit windows go one window after they end;
    - deletes run in batches, 1 s per table each minute, and skip locked rows.
  - A migration that rewrites these tables while they hold weeks of traffic is online. The
    one-transaction runner hit the 10 s statement timeout at about 200 000 reservations
    (task 0050); at 1 000 000 under a 10-minute bound it applied in 58 s while 56 of 60 `reserve`
    calls failed on their lock timeout (task 0067).
  - A backfill's WAL delays every `COMMIT` written after it, `reserve`'s included, and a
    `reserve` waiting on the disk holds the global scope's row lock, so the others queue on it.
    The pause between batches keeps that delay short; without the backfill the same load never
    waited past 0.4 s (task 0067). Any `COMMIT` slower than `reserve`'s 2 s lock timeout, for any
    reason, fails the reservations queued behind it.
  - An online migration's budget: under 1% of `reserve` calls fail while it runs. At 1 000 000
    reservations on a laptop's disk, 7 of 21 942 failed (0.03%), all on disk stalls (task 0067).
  - Task 0026 measures the full settle path and `addHash` on the testnet database it creates;
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
  - the PostgreSQL container and its internal network;
  - the password credential;
  - the migration step in the deploy script;
  - the backups and the restore drill.
- **What was built for several processes** (the lease, separate pools, skew margins) stays correct
  for one, so running several instances is an option kept open, not a decision.
- **Exit.** The ports are the seam. Moving to RDS or Aurora PostgreSQL is a dump and restore.
  Moving to another store means new adapters that pass the same suites, once task 0022 has closed the gaps
  listed in G.

## References

- [Task 0013](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/README.md):
  [options and sources](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/notes/R-state-store-options.md),
  [decision](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/notes/S-state-store-decision.md),
  [PostgreSQL mapping](../../lore/1-tasks/archive/0013_RESEARCH_facilitator-state-store/notes/G-postgres-port-mapping.md)
- [M1 architecture spine](../architecture/m1-spine.md): AD-6, AD-7, AD-11, AD-16 to AD-20
- [ADR 0006](0006-settlement-record.md), [ADR 0007](0007-fee-abuse-containment.md),
  [ADR 0008](0008-bazaar-catalog-integrity.md), [ADR 0011](0011-facilitator-hosting.md)
