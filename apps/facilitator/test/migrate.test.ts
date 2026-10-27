import pg from "pg";
import { describe, expect, it } from "vitest";
import { RESERVE_LOCK_TIMEOUT_MS, postgresStores } from "../src/adapters/postgres.js";
import {
  MIGRATE_LOCK,
  MIGRATIONS,
  STEP_LOCK_TIMEOUT_MS,
  migrate,
  type MigrateOptions,
  type Migration,
  type OnlineMigration,
  type OnlineStep,
} from "../src/adapters/postgres-schema.js";
import type { SpendLimit } from "../src/ports/index.js";
import { testDatabase } from "./database.js";

/**
 * The online runner (0067). The test migration adds a NOT NULL column with a backfill and an
 * index to `spend_reservation_scopes`, which `reserve` writes while it holds the scope rows' lock.
 */
describe("online migrations", () => {
  const db = testDatabase(4);
  const { schema, pool, poolFor, urlFor } = db;

  /** Reservations seeded by `seeded`; `MIGRATE_SCALE=1000000` is AC1's run. */
  const SCALE = Number(process.env.MIGRATE_SCALE ?? 20_000);
  const T = "spend_reservation_scopes";

  const steps = (backfill: { batch?: number; pauseMs?: number } = {}): OnlineStep[] => [
    { kind: "sql", sql: `ALTER TABLE ${T} ADD COLUMN c bigint` },
    { kind: "sql", sql: `ALTER TABLE ${T} ALTER COLUMN c SET DEFAULT 0` },
    { kind: "sql", sql: `ALTER TABLE ${T} ADD CONSTRAINT ${T}_c_nn NOT NULL c NOT VALID` },
    {
      kind: "backfill",
      table: T,
      key: ["scope", "id"],
      set: "c = amount",
      where: "t.c IS NULL",
      ...backfill,
    },
    { kind: "validate", table: T, constraint: `${T}_c_nn` },
    { kind: "index", name: `${T}_c`, table: T, definition: "(c)" },
  ];
  const online = (backfill?: { batch?: number; pauseMs?: number }): OnlineMigration => ({
    name: "0100_scope_c",
    online: true,
    steps: steps(backfill),
  });
  /** The same migration cut after `done` steps and failing there: a run that stopped at a step. */
  const stoppedAfter = (done: number, backfill?: { batch?: number; pauseMs?: number }) => ({
    ...online(backfill),
    steps: [...steps(backfill).slice(0, done), { kind: "sql" as const, sql: "SELECT 1 / 0" }],
  });

  /** `migrate` on `fresh` through a pool of its own. */
  const run = async (fresh: string, migrations: readonly Migration[], options?: MigrateOptions) => {
    const on = poolFor(fresh, 1);
    try {
      return await migrate(on, 0, migrations, options);
    } finally {
      await on.end();
    }
  };

  /** Runs `fn` on a schema of its own, migrated to the current `MIGRATIONS`. */
  const onSchema = async (suffix: string, fn: (fresh: string, on: pg.Pool) => Promise<void>) => {
    const fresh = `${schema}_${suffix}`;
    await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    await pool.query(`CREATE SCHEMA ${fresh}`);
    const on = poolFor(fresh, 8);
    try {
      await migrate(on);
      await fn(fresh, on);
    } finally {
      await on.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    }
  };

  /**
   * `reservations` reservations 40 days back, outside every window, each with the four scope rows
   * of the default config.
   */
  const seeded = async (fresh: string, reservations: number) => {
    const client = new pg.Client({ connectionString: urlFor(fresh), statement_timeout: 0 });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO spend_reservations (id, amount, at, state)
         SELECT 'seed-' || g, 100 + g % 900, $1::bigint - g,
                CASE WHEN g % 10 = 0 THEN 'reserved' ELSE 'committed' END
         FROM generate_series(1, $2::int) g`,
        [Date.now() - 40 * 86_400_000, reservations],
      );
      await client.query(
        `INSERT INTO ${T} (scope, id, at, amount)
         SELECT s.scope, r.id, r.at, r.amount FROM spend_reservations r,
           LATERAL (VALUES ('global'), ('payer:P' || (substr(r.id, 6)::int % 1000)),
             ('payTo:Q' || (substr(r.id, 6)::int % 50)), ('asset:C' || (substr(r.id, 6)::int % 5))
           ) AS s (scope)`,
      );
      await client.query(`VACUUM (ANALYZE) ${T}`);
    } finally {
      await client.end();
    }
  };

  /** The migration's end state, read on `on`. */
  const finished = async (on: pg.Pool) => {
    const { rows } = await on.query(
      `SELECT
         (SELECT attnotnull FROM pg_attribute
          WHERE attrelid = to_regclass('${T}') AND attname = 'c') AS not_null,
         (SELECT convalidated FROM pg_constraint
          WHERE conname = '${T}_c_nn' AND connamespace = current_schema()::regnamespace) AS validated,
         (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('${T}_c')) AS index_valid,
         (SELECT count(*) FROM ${T} WHERE c IS NULL)::int AS nulls,
         (SELECT count(*) FROM ${T} WHERE id LIKE 'seed-%' AND c <> amount)::int AS wrong`,
    );
    return rows[0];
  };
  const done = { not_null: true, validated: true, index_valid: true, nulls: 0, wrong: 0 };

  const markers = async (on: pg.Pool) =>
    (
      await on.query<{ name: string }>(
        "SELECT name FROM schema_migrations WHERE name LIKE '0100%' ORDER BY name",
      )
    ).rows.map((row) => row.name);

  /** The pid of the `migrate` run holding `fresh`'s lock, once it waits on a lock. */
  const waitingMigrator = async (fresh: string): Promise<number> => {
    for (;;) {
      const { rows } = await pool.query<{ pid: number }>(
        `SELECT a.pid FROM pg_locks l JOIN pg_stat_activity a USING (pid)
         WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 2
           AND l.classid = $1::bigint::oid
           AND l.objid = ((hashtext($2)::bigint + 4294967296) % 4294967296)::oid
           AND a.wait_event_type = 'Lock'`,
        [MIGRATE_LOCK, fresh],
      );
      if (rows[0]) return rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /** Runs `fn` in a transaction on its own connection to `fresh`, rolled back after. */
  const holding = async (on: pg.Pool, fn: (client: pg.PoolClient) => Promise<void>) => {
    const client = await on.connect();
    try {
      await client.query("BEGIN");
      await fn(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };

  const limits: SpendLimit[] = [
    { scope: "global", maxStroops: 10n ** 15n, windowMs: 86_400_000 },
    { scope: "payer:P1", maxStroops: 10n ** 15n, windowMs: 86_400_000 },
    { scope: "payTo:Q1", maxStroops: 10n ** 15n, windowMs: 86_400_000 },
    { scope: "asset:C1", maxStroops: 10n ** 15n, windowMs: 86_400_000 },
  ];

  /** Four loops calling the release before the migration's `reserve`, until `stop`. */
  const reserving = (on: pg.Pool) => {
    const { spend } = postgresStores(on);
    const samples: { at: number; ms: number; error?: unknown }[] = [];
    let stopped = false;
    let n = 0;
    const loop = async () => {
      while (!stopped) {
        const at = Date.now();
        try {
          await spend.reserve({ id: `live-${n++}`, amount: 1n, limits, now: at });
          samples.push({ at, ms: Date.now() - at });
        } catch (error) {
          samples.push({ at, ms: Date.now() - at, error });
        }
      }
    };
    const loops = Promise.all([loop(), loop(), loop(), loop()]);
    return {
      samples,
      stop: async () => {
        stopped = true;
        await loops;
      },
    };
  };
  const p99 = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.99)] ?? 0;

  it("keeps a step's lock wait well below reserve's", () => {
    // A step waits at most its lock timeout and then holds the lock for milliseconds; `reserve`
    // queued behind it must not reach its own timeout meanwhile.
    expect(2 * STEP_LOCK_TIMEOUT_MS).toBeLessThanOrEqual(RESERVE_LOCK_TIMEOUT_MS);
  });

  it(
    "applies a NOT NULL column with a backfill and an index while reserve keeps answering",
    async () => {
      await onSchema("live", async (fresh, on) => {
        await seeded(fresh, SCALE);
        const load = reserving(on);
        const steps: { step: number; ms: number; at: number }[] = [];
        const logger = {
          info: (event: string, fields?: Record<string, unknown>) => {
            if (event === "migration_step")
              steps.push({ ...(fields as { step: number; ms: number }), at: Date.now() });
          },
        };
        try {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const started = Date.now();
          expect(await run(fresh, [...MIGRATIONS, online()], { logger })).toEqual(["0100_scope_c"]);
          const ended = Date.now();
          await load.stop();
          const before = load.samples.filter((s) => s.at < started);
          const during = load.samples.filter((s) => s.at >= started && s.at < ended);
          // AC1's run records where the time went: each step's window and every failed reserve,
          // in ms from the migration's start.
          if (process.env.MIGRATE_SCALE) console.log(JSON.stringify(report(started, ended)));
          const failed = load.samples.filter((s) => s.error);
          // AC1: no reserve fails waiting on a step that takes ACCESS EXCLUSIVE (steps 1–3).
          const locking = steps.filter((s) => s.step <= 3).map((s) => [s.at - s.ms, s.at]);
          expect(
            failed.filter((f) => locking.some(([from, to]) => f.at < to! && f.at + f.ms > from!)),
          ).toEqual([]);
          // At AC1's scale a disk stall during the backfill can slow a COMMIT that holds the
          // global scope row past reserve's lock timeout; the suite's scale allows no error.
          if (!process.env.MIGRATE_SCALE) expect(failed).toEqual([]);
          expect(during.length).toBeGreaterThan(0);
          // Waits behind a step are bounded by its lock timeout, not by how long it runs.
          expect(p99(during.map((s) => s.ms))).toBeLessThan(
            p99(before.map((s) => s.ms)) + STEP_LOCK_TIMEOUT_MS + 250,
          );
        } finally {
          await load.stop();
        }
        function report(started: number, ended: number) {
          const stats = (from: number, to: number) => {
            const ms = load.samples.filter((s) => s.at >= from && s.at < to).map((s) => s.ms);
            const sorted = [...ms].sort((a, b) => a - b);
            return {
              n: ms.length,
              p50: sorted[Math.floor(ms.length / 2)],
              p99: p99(ms),
              max: sorted.at(-1),
            };
          };
          return {
            scale: SCALE,
            migrationMs: ended - started,
            before: stats(0, started),
            during: stats(started, ended),
            steps: steps.map((s) => ({
              step: s.step,
              from: s.at - s.ms - started,
              to: s.at - started,
            })),
            errors: load.samples
              .filter((s) => s.error)
              .map((s) => ({
                at: s.at - started,
                ms: s.ms,
                code: (s.error as { code?: string }).code,
              })),
          };
        }
        expect(steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(await finished(on)).toEqual(done);
        expect(await markers(on)).toEqual([
          "0100_scope_c",
          ...[1, 2, 3, 4, 5, 6].map((i) => `0100_scope_c#${i}`),
        ]);
      });
    },
    120_000 + SCALE,
  );

  it("retries a step whose lock another session holds, and reserve waits at most its lock timeout", async () => {
    await onSchema("held", async (fresh, on) => {
      await seeded(fresh, 100);
      let retries = -1;
      const logger = {
        info: (event: string, fields?: Record<string, unknown>) => {
          if (event === "migration_step" && fields?.step === 1) retries = fields.retries as number;
        },
      };
      let migrating: Promise<string[]> | undefined;
      await holding(on, async (client) => {
        // A long read: ADD COLUMN waits for it behind its lock timeout.
        await client.query(`SELECT 1 FROM ${T} LIMIT 1`);
        migrating = run(fresh, [online({ pauseMs: 0 })], { logger });
        await waitingMigrator(fresh);
        const started = Date.now();
        await postgresStores(on).spend.reserve({ id: "r", amount: 1n, limits, now: started });
        expect(Date.now() - started).toBeLessThan(STEP_LOCK_TIMEOUT_MS + 500);
        await new Promise((resolve) => setTimeout(resolve, STEP_LOCK_TIMEOUT_MS));
      });
      expect(await migrating).toEqual(["0100_scope_c"]);
      expect(retries).toBeGreaterThanOrEqual(1);
      expect(await finished(on)).toEqual(done);
    });
  }, 30_000);

  /** A run killed while step `at` waits on the lock `hold` takes, then the next run. */
  const killedAndResumed = async (
    suffix: string,
    at: number,
    hold: (client: pg.PoolClient) => Promise<void>,
    left: (on: pg.Pool) => Promise<void>,
  ) => {
    await onSchema(suffix, async (fresh, on) => {
      await seeded(fresh, 2_000);
      const backfill = { batch: 500, pauseMs: 0 };
      await expect(run(fresh, [stoppedAfter(at - 1, backfill)])).rejects.toThrow(
        /division by zero/,
      );
      await holding(on, async (client) => {
        await hold(client);
        const killed = run(fresh, [online(backfill)]);
        const pid = await waitingMigrator(fresh);
        await pool.query("SELECT pg_terminate_backend($1)", [pid]);
        await expect(killed).rejects.toThrow();
      });
      expect(await markers(on)).toEqual(
        Array.from({ length: at - 1 }, (_, i) => `0100_scope_c#${i + 1}`),
      );
      await left(on);
      // The killed run's lock went with its connection: the next run takes it at once.
      expect(await run(fresh, [online(backfill)], { lockWaitMs: 2_000 })).toEqual(["0100_scope_c"]);
      expect(await finished(on)).toEqual(done);
    });
  };

  it(
    "finishes a run killed at the backfill's first batch",
    () =>
      killedAndResumed(
        "kill_first",
        4,
        (client) =>
          client.query(`SELECT 1 FROM ${T} ORDER BY scope, id LIMIT 1 FOR UPDATE`).then(() => {}),
        async (on) => {
          const { rows } = await on.query(`SELECT count(*)::int AS n FROM ${T} WHERE c IS NULL`);
          expect(rows[0].n).toBe(8_000);
        },
      ),
    30_000,
  );

  it(
    "finishes a run killed part way through the backfill",
    () =>
      killedAndResumed(
        "kill_mid",
        4,
        // The row by its key: `FOR UPDATE` with `OFFSET` would lock the rows it skips too.
        (client) =>
          client
            .query(
              `SELECT 1 FROM ${T} WHERE (scope, id) =
                 (SELECT scope, id FROM ${T} ORDER BY scope, id OFFSET 4000 LIMIT 1) FOR UPDATE`,
            )
            .then(() => {}),
        async (on) => {
          const { rows } = await on.query(
            `SELECT count(*) FILTER (WHERE c IS NULL)::int AS empty, count(*)::int AS n FROM ${T}`,
          );
          expect(rows[0].empty).toBeGreaterThan(0);
          expect(rows[0].empty).toBeLessThan(rows[0].n);
        },
      ),
    30_000,
  );

  it(
    "finishes a run killed while it validates",
    () =>
      killedAndResumed(
        "kill_validate",
        5,
        (client) => client.query(`LOCK TABLE ${T} IN SHARE UPDATE EXCLUSIVE MODE`).then(() => {}),
        async (on) => {
          const { rows } = await on.query(
            `SELECT convalidated FROM pg_constraint
             WHERE conname = '${T}_c_nn' AND connamespace = current_schema()::regnamespace`,
          );
          expect(rows[0].convalidated).toBe(false);
        },
      ),
    30_000,
  );

  it(
    "drops and rebuilds the INVALID index a killed build leaves",
    () =>
      killedAndResumed(
        "kill_index",
        6,
        // An open writer: CREATE INDEX CONCURRENTLY waits for it after creating the index.
        (client) => client.query(`UPDATE ${T} SET c = c WHERE id = 'seed-2'`).then(() => {}),
        async (on) => {
          const { rows } = await on.query(
            `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('${T}_c')`,
          );
          expect(rows).toEqual([{ indisvalid: false }]);
        },
      ),
    30_000,
  );

  it("applies an online migration once when two runs race", async () => {
    await onSchema("race", async (fresh) => {
      const migrations: Migration[] = [...MIGRATIONS, online({ pauseMs: 0 })];
      const runs = await Promise.all([run(fresh, migrations), run(fresh, migrations)]);
      expect(runs).toContainEqual(["0100_scope_c"]);
      expect(runs).toContainEqual([]);
    });
  }, 30_000);

  it("locks one schema at a time, not the database", async () => {
    await onSchema("lock", async (fresh) => {
      const other = await pool.connect();
      try {
        await other.query("SELECT pg_advisory_lock($1, hashtext($2))", [
          MIGRATE_LOCK,
          `${fresh}_x`,
        ]);
        expect(await run(fresh, [online()], { lockWaitMs: 1_000 })).toEqual(["0100_scope_c"]);
        await other.query("SELECT pg_advisory_lock($1, hashtext($2))", [MIGRATE_LOCK, fresh]);
        await expect(
          run(fresh, [{ name: "0101_t", sql: "SELECT 1" }], { lockWaitMs: 300 }),
        ).rejects.toThrow(/held the lock/);
      } finally {
        await other.query("SELECT pg_advisory_unlock_all()");
        other.release();
      }
    });
  }, 30_000);

  it("splits the transactional group at an online migration", async () => {
    await onSchema("group", async (fresh, on) => {
      const first = { name: "0101_first", sql: "CREATE TABLE first (id int)" };
      const broken = { name: "0102_broken", sql: "SELECT 1 / 0" };
      await expect(run(fresh, [first, online({ pauseMs: 0 }), broken])).rejects.toThrow(
        /division by zero/,
      );
      // The migrations before the online one committed; only the failed group rolled back.
      const { rows } = await on.query<{ name: string }>(
        "SELECT name FROM schema_migrations WHERE name NOT LIKE '%#%' AND name > '0100' ORDER BY name",
      );
      expect(rows.map((row) => row.name)).toEqual(["0100_scope_c", "0101_first"]);
      expect(await run(fresh, [first, online(), { ...broken, sql: "SELECT 1" }])).toEqual([
        "0102_broken",
      ]);
    });
  }, 30_000);

  it("retries a backfill batch that ran out of time", async () => {
    await onSchema("slow", async (fresh, on) => {
      await seeded(fresh, 100);
      // The first call outlasts the batch's statement timeout; a sequence isn't rolled back, so
      // the retried batch runs at once.
      await on.query(
        `CREATE SEQUENCE once;
         CREATE FUNCTION slow_once() RETURNS bigint LANGUAGE plpgsql AS $$
         BEGIN
           IF nextval('once') = 1 THEN PERFORM pg_sleep(6); END IF;
           RETURN 0;
         END $$`,
      );
      const slow: OnlineMigration = {
        name: "0100_scope_c",
        online: true,
        steps: [
          steps()[0]!,
          {
            kind: "backfill",
            table: T,
            key: ["scope", "id"],
            set: "c = amount + slow_once()",
            where: "t.c IS NULL",
            pauseMs: 0,
          },
        ],
      };
      expect(await run(fresh, [slow])).toEqual(["0100_scope_c"]);
      const { rows } = await on.query(`SELECT count(*)::int AS n FROM ${T} WHERE c IS NULL`);
      expect(rows[0].n).toBe(0);
    });
  }, 30_000);

  it("fails a backfill that leaves rows matching its condition", async () => {
    await onSchema("left", async (fresh, on) => {
      await seeded(fresh, 100);
      const leaving: OnlineMigration = {
        name: "0100_scope_c",
        online: true,
        steps: [
          steps()[0]!,
          {
            kind: "backfill",
            table: T,
            key: ["scope", "id"],
            set: "c = NULL",
            where: "t.c IS NULL",
            pauseMs: 0,
          },
        ],
      };
      await expect(run(fresh, [leaving])).rejects.toThrow(/left rows/);
      expect(await markers(on)).toEqual(["0100_scope_c#1"]);
    });
  }, 30_000);
});
