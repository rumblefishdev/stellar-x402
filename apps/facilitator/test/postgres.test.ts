import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresStores } from "../src/adapters/postgres.js";
import { MIGRATIONS, migrate } from "../src/adapters/postgres-schema.js";
import { NON_FINAL_STATES } from "../src/adapters/rules.js";
import { main, migrateMain } from "../src/main.js";
import { HashConflictError, type Stores } from "../src/ports/index.js";
import { fingerprintOf, keyOf } from "../src/settlement/settle.js";
import { testDatabase } from "./database.js";
import { transferPayload } from "./payment.js";
import {
  catalogStoreContract,
  rateLimitStoreContract,
  settlement,
  settlementStoreContract,
  spendStoreContract,
} from "./port-contracts.js";
import { hardened, rpcStub } from "./rpc-stub.js";

// `main()` checks its channel at startup, on the RPC it builds from `RPC_URLS`.
const bootSecret = Keypair.random().secret();
const bootChannel = Keypair.random().publicKey();
let rpc: Awaited<ReturnType<typeof rpcStub>>;
beforeAll(async () => {
  rpc = await rpcStub({ [bootChannel]: hardened(Keypair.fromSecret(bootSecret).publicKey()) });
});
afterAll(() => rpc.close());

/** One catalog entry, as the cataloger writes it after a settlement. */
const catalogEntry = () => ({
  key: {
    network: "stellar:testnet" as const,
    payTo: "GPAYTO",
    method: "GET",
    resourceUrl: "https://seller.example.com/data",
  },
  keyVersion: CATALOG_KEY_VERSION,
  ledger: 1,
  resource: {
    resource: "https://seller.example.com/data",
    type: "http",
    x402Version: 2 as const,
    accepts: [],
    lastUpdated: "2026-10-08T00:00:00.000Z",
  },
});

/** The contract suites and the PostgreSQL-only cases (locks, pools, migrations). */
describe("PostgreSQL stores", () => {
  // More connections than the contracts' 10-way concurrent cases, so each runs on its own.
  const db = testDatabase(20);
  const { schema, pool, urlFor, poolFor } = db;
  let connections = 0;
  pool.on("connect", () => connections++);

  const stores = async (): Promise<Stores> => {
    await db.empty();
    return db.stores();
  };

  settlementStoreContract(async () => (await stores()).settlements);
  spendStoreContract(async () => (await stores()).spend);
  rateLimitStoreContract(async () => (await stores()).rateLimits);
  catalogStoreContract(async () => (await stores()).catalog);

  /**
   * Resolves the pid of a backend waiting on a lock `holder` holds, once one is. Other test files
   * share the database, so a lock wait of theirs doesn't count.
   */
  const lockWaiter = async (holder: pg.PoolClient): Promise<number> => {
    const held = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    for (;;) {
      const { rows } = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND $1 = ANY(pg_blocking_pids(pid))`,
        [held.rows[0]!.pid],
      );
      if (rows[0]) return rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** Runs `fn` in a transaction on its own connection; `fn` decides when it ends. */
  const holding = async (fn: (client: pg.PoolClient) => Promise<void>) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await fn(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };

  it("rejects a hash another record's insert commits while addHash waits on it", async () => {
    const { settlements } = await stores();
    const [s1, s2] = [settlement("1"), settlement("2")];
    await settlements.claim(s1);
    await settlements.claim(s2);
    await holding(async (client) => {
      await client.query("INSERT INTO settlement_hashes (hash, key) VALUES ('h1', $1)", [s1.key]);
      const adding = settlements.addHash(s2.key, "h1", 3_000);
      await lockWaiter(client);
      await client.query("COMMIT");
      await expect(adding).rejects.toBeInstanceOf(HashConflictError);
    });
  });

  it("adds a hash, and keeps the state, when a transition commits while addHash waits", async () => {
    const { settlements } = await stores();
    const { key } = settlement("1");
    await settlements.claim(settlement("1"));
    await holding(async (client) => {
      // A transition claimed → pending, as its UPDATE runs, holding the record's lock.
      await client.query(
        "UPDATE settlements SET state = 'pending', updated_at = 2500 WHERE key = $1",
        [key],
      );
      const adding = settlements.addHash(key, "h1", 3_000);
      await lockWaiter(client);
      await client.query("COMMIT");
      expect(await adding).toBe(true);
    });
    // `claimed → signed` applies to the state after the wait, so `pending` doesn't move back.
    expect(await settlements.get(key)).toMatchObject({
      state: "pending",
      hashes: ["h1"],
      updatedAt: 3_000,
    });
  });

  it("returns the hashes committed while transition waited on the record", async () => {
    const { settlements } = await stores();
    const { key } = settlement("1");
    await settlements.claim(settlement("1"));
    await settlements.addHash(key, "h1", 2_000);
    await settlements.transition(key, "signed", { state: "pending", updatedAt: 2_500 });
    await holding(async (client) => {
      await client.query("SELECT 1 FROM settlements WHERE key = $1 FOR UPDATE", [key]);
      await client.query("INSERT INTO settlement_hashes (hash, key) VALUES ('h2', $1)", [key]);
      const moving = settlements.transition(key, "pending", {
        state: "success",
        ledger: 1,
        updatedAt: 3_000,
      });
      await lockWaiter(client);
      await client.query("COMMIT");
      expect(await moving).toMatchObject({ state: "success", hashes: ["h1", "h2"] });
    });
  });

  it("fails a transaction whose connection drops, keeps running, and drops the connection", async () => {
    await stores();
    // One connection, so the calls after the drop must reuse it or replace it.
    const single = poolFor(schema, 1);
    try {
      const { settlements, spend } = postgresStores(single);
      const limits = [{ scope: "global" as const, maxStroops: 10n, windowMs: 1_000 }];
      await holding(async (client) => {
        await client.query("INSERT INTO spend_scopes (scope) VALUES ('global')");
        const reserving = spend.reserve({ id: "a", amount: 1n, limits, now: 0 });
        await pool.query("SELECT pg_terminate_backend($1)", [await lockWaiter(client)]);
        await expect(reserving).rejects.toThrow();
      });
      expect(await spend.reserve({ id: "b", amount: 1n, limits, now: 0 })).toEqual({
        reserved: true,
      });
      expect((await settlements.claim(settlement("1"))).claimed).toBe(true);
    } finally {
      await single.end();
    }
  });

  it("drops a live connection whose ROLLBACK failed, so its open transaction isn't reused", async () => {
    await stores();
    const single = poolFor(schema, 1);
    const query = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      if (args[0] === "ROLLBACK") return Promise.reject(new Error("ROLLBACK failed"));
      return (query as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof query);
    try {
      const { settlements, spend } = postgresStores(single);
      // Over the limit, so the transaction rolls back, and the stubbed ROLLBACK fails.
      const limits = [{ scope: "global" as const, maxStroops: 0n, windowMs: 1_000 }];
      expect(await spend.reserve({ id: "a", amount: 1n, limits, now: 0 })).toEqual({
        reserved: false,
        scope: "global",
      });
      spy.mockRestore();
      expect(single.totalCount).toBe(0);
      // A reused connection would run this inside the still-open transaction, never committed.
      expect((await settlements.claim(settlement("1"))).claimed).toBe(true);
      const { rows } = await pool.query("SELECT key FROM settlements");
      expect(rows).toHaveLength(1);
    } finally {
      spy.mockRestore();
      await single.end();
    }
  });

  it("keeps reservations queued on the scope lock from starving the other stores", async () => {
    await stores();
    await pool.query("INSERT INTO spend_scopes (scope) VALUES ('global')");
    const main = poolFor(schema, 2);
    const reserving = poolFor(schema, 1);
    try {
      const { settlements, spend } = postgresStores(main, { reserve: reserving });
      const limits = [{ scope: "global" as const, maxStroops: 10n, windowMs: 1_000 }];
      let queued: Promise<unknown>[] = [];
      await holding(async (client) => {
        await client.query("SELECT scope FROM spend_scopes WHERE scope = 'global' FOR UPDATE");
        // More reservations than the main pool has connections, all waiting on the lock.
        queued = ["a", "b", "c"].map((id) => spend.reserve({ id, amount: 1n, limits, now: 0 }));
        await lockWaiter(client);
        const started = Date.now();
        expect((await settlements.claim(settlement("1"))).claimed).toBe(true);
        expect(Date.now() - started).toBeLessThan(1_000);
      });
      await Promise.allSettled(queued);
    } finally {
      await main.end();
      await reserving.end();
    }
  });

  it("keeps hits queued on one key's lock from starving the other stores", async () => {
    await stores();
    await pool.query("INSERT INTO rate_limits (key, count, reset_at) VALUES ('k', 1, 60000)");
    const main = poolFor(schema, 2);
    const limiting = poolFor(schema, 1);
    try {
      const { settlements, rateLimits } = postgresStores(main, { rateLimits: limiting });
      let queued: Promise<unknown>[] = [];
      await holding(async (client) => {
        await client.query("SELECT key FROM rate_limits WHERE key = 'k' FOR UPDATE");
        // One client's flood: more hits on its key than the main pool has connections.
        queued = [0, 1, 2].map(() => rateLimits.hit("k", 60_000, 0));
        await lockWaiter(client);
        const started = Date.now();
        expect((await settlements.claim(settlement("1"))).claimed).toBe(true);
        expect(Date.now() - started).toBeLessThan(1_000);
      });
      await Promise.allSettled(queued);
    } finally {
      await main.end();
      await limiting.end();
    }
  });

  it("gives up a reservation that waits on the scope lock too long", async () => {
    const { spend } = await stores();
    await pool.query("INSERT INTO spend_scopes (scope) VALUES ('global')");
    const limits = [{ scope: "global" as const, maxStroops: 10n, windowMs: 1_000 }];
    await holding(async (client) => {
      await client.query("SELECT scope FROM spend_scopes WHERE scope = 'global' FOR UPDATE");
      await expect(spend.reserve({ id: "a", amount: 1n, limits, now: 0 })).rejects.toMatchObject({
        code: "55P03",
      });
    });
    expect(await spend.reserve({ id: "a", amount: 1n, limits, now: 0 })).toEqual({
      reserved: true,
    });
  });

  it("resets no failures without waiting on a reservation's scope lock", async () => {
    const { spend } = await stores();
    await pool.query("INSERT INTO spend_scopes (scope) VALUES ('asset:CX')");
    await holding(async (client) => {
      await client.query("SELECT scope FROM spend_scopes WHERE scope = 'asset:CX' FOR UPDATE");
      const reset = spend.recordSuccess("asset:CX").then(() => "reset");
      const waited = new Promise((resolve) => setTimeout(() => resolve("waited"), 1_000));
      expect(await Promise.race([reset, waited])).toBe("reset");
    });
  });

  it("runs every statement at Read Committed under a stricter server default", async () => {
    await stores();
    const strict = poolFor(schema, 20, "-c default_transaction_isolation=serializable");
    try {
      const { rows } = await strict.query("SHOW transaction_isolation");
      expect(rows).toEqual([{ transaction_isolation: "read committed" }]);
      const { settlements } = postgresStores(strict);
      const s = settlement("1");
      const results = await Promise.all(Array.from({ length: 10 }, () => settlements.claim(s)));
      expect(results.filter((result) => result.claimed)).toHaveLength(1);
    } finally {
      await strict.end();
    }
  });

  it("closes a connection that can't set Read Committed, before anyone uses it", async () => {
    const strict = poolFor(schema, 1, "-c default_transaction_isolation=serializable");
    const query = pg.Client.prototype.query;
    const cause = new Error("SET failed");
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      if (typeof args[0] === "string" && args[0].startsWith("SET SESSION")) {
        return Promise.reject(cause);
      }
      return (query as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof query);
    try {
      await expect(strict.query("SELECT 1")).rejects.toThrow(
        expect.objectContaining({
          message: "could not set Read Committed on a new connection",
          cause,
        }),
      );
      expect(strict.totalCount).toBe(0);
      spy.mockRestore();
      const { rows } = await strict.query("SHOW transaction_isolation");
      expect(rows).toEqual([{ transaction_isolation: "read committed" }]);
    } finally {
      spy.mockRestore();
      await strict.end();
    }
  });

  it("ran the concurrent cases on separate connections", () => {
    expect(connections).toBeGreaterThanOrEqual(10);
  });

  it("boots main() with reserves, limits and listings on their own pools, catalog writes and pruning on the main one, a short timeout for listings, and ends them", async () => {
    await stores();
    const app = await main({
      DATABASE_URL: urlFor(schema),
      FACILITATOR_SECRET: bootSecret,
      CLIENT_IP: "socket",
      CHANNELS: bootChannel,
      RPC_URLS: rpc.url,
      PORT: "0",
      LOG_LEVEL: "error",
    });
    const pools = app.pools;
    expect(pools).toBeDefined();
    try {
      // The startup sweep reads the settlements on the main pool, and only there.
      await app.reconciled;
      const main = pools?.main.totalCount;
      expect(main).toBeGreaterThan(0);
      const limits = [{ scope: "global" as const, maxStroops: 10n, windowMs: 1_000 }];
      // Nothing but the main pool served the sweep.
      expect([
        pools?.reserve.totalCount,
        pools?.rateLimits.totalCount,
        pools?.discovery.totalCount,
      ]).toEqual([0, 0, 0]);
      // Checkouts, not connections: a pool reuses an idle connection, so only a checkout shows
      // which pool a call ran on once the pool has one.
      const checkouts = { main: 0, reserve: 0, rateLimits: 0, discovery: 0 };
      const names = Object.keys(checkouts) as (keyof typeof checkouts)[];
      for (const name of names) pools?.[name].on("acquire", () => checkouts[name]++);
      const ranOn = async (call: () => Promise<unknown>) => {
        const before = { ...checkouts };
        await call();
        return names.filter((name) => checkouts[name] > before[name]);
      };
      expect(
        await ranOn(() => app.stores.spend.reserve({ id: "a", amount: 1n, limits, now: 0 })),
      ).toEqual(["reserve"]);
      expect(await ranOn(() => app.stores.rateLimits.hit("k", 60_000, 0))).toEqual(["rateLimits"]);
      expect(await ranOn(() => app.stores.catalog.list({ limit: 1, offset: 0 }))).toEqual([
        "discovery",
      ]);
      // Catalog writes come from `/settle`, so they stay off the public listings' pool.
      expect(await ranOn(() => app.stores.catalog.upsert(catalogEntry()))).toEqual(["main"]);
      expect(await ranOn(() => app.stores.settlements.claim(settlement("1")))).toEqual(["main"]);
      // A flood's pruning takes no connection from `hit` or `reserve` (decision 9).
      expect(await ranOn(() => app.stores.rateLimits.prune(0, 10))).toEqual(["main"]);
      expect(await ranOn(() => app.stores.spend.prune(0, 10))).toEqual(["main"]);
      // Only the public listings' pool cuts a statement off early.
      const timeouts = await Promise.all(
        names.map(async (name) => {
          const shown = await pools?.[name].query<{ statement_timeout: string }>(
            "SHOW statement_timeout",
          );
          return shown?.rows[0]?.statement_timeout;
        }),
      );
      expect(timeouts).toEqual(["10s", "10s", "10s", "2s"]);
    } finally {
      await app.close();
    }
    expect([
      pools?.main.ended,
      pools?.reserve.ended,
      pools?.rateLimits.ended,
      pools?.discovery.ended,
    ]).toEqual([true, true, true, true]);
  });

  it("answers main()'s /settle from the PostgreSQL record", async () => {
    // A repeat is answered from its record before any check or RPC call, so only a `/settle` wired
    // to these stores gives this answer; on other stores it would start a new settlement.
    const { settlements } = await stores();
    const requirements = {
      scheme: "exact",
      network: "stellar:testnet",
      asset: StrKey.encodeContract(Buffer.alloc(32, 7)),
      amount: "1000",
      payTo: Keypair.random().publicKey(),
      maxTimeoutSeconds: 60,
      extra: {},
    } satisfies PaymentRequirements;
    const payer = Keypair.random().publicKey();
    const paymentPayload = transferPayload(
      { payer, payTo: requirements.payTo, requirements },
      1_000,
    );
    const key = keyOf(paymentPayload, "stellar:testnet");
    if (!key) throw new Error("the payload has no settlement key");
    const now = Date.now();
    await settlements.claim({
      key,
      network: "stellar:testnet",
      payer,
      nonce: "7",
      fingerprint: fingerprintOf(paymentPayload, requirements),
      paymentPayload,
      paymentRequirements: requirements,
      createdAt: now,
    });
    await settlements.addHash(key, "h1", now);
    await settlements.transition(key, "signed", { state: "success", updatedAt: now });
    const app = await main({
      DATABASE_URL: urlFor(schema),
      FACILITATOR_SECRET: bootSecret,
      CLIENT_IP: "socket",
      CHANNELS: bootChannel,
      RPC_URLS: rpc.url,
      PORT: "0",
      LOG_LEVEL: "error",
    });
    try {
      await app.reconciled;
      const response = await fetch(`http://127.0.0.1:${app.port}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements }),
      });
      expect(await response.json()).toEqual({
        success: true,
        transaction: "h1",
        network: "stellar:testnet",
        payer,
      });
      expect((await settlements.get(key))?.successAnsweredAt).toEqual(expect.any(Number));
    } finally {
      await app.close();
    }
  });

  it("closes once when two signals call close()", async () => {
    const app = await main({
      DATABASE_URL: urlFor(schema),
      FACILITATOR_SECRET: bootSecret,
      CLIENT_IP: "socket",
      CHANNELS: bootChannel,
      RPC_URLS: rpc.url,
      PORT: "0",
      LOG_LEVEL: "error",
    });
    // SIGTERM then SIGINT: the second call waits for the first instead of ending the pools early.
    const [first, second] = [app.close(), app.close()];
    expect(second).toBe(first);
    await first;
    expect(app.pools?.main.ended).toBe(true);
  });

  it("applies every migration once, in order", async () => {
    expect(db.applied).toEqual(MIGRATIONS.map((migration) => migration.name));
    expect(await migrate(pool)).toEqual([]);
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'settlements_non_final'",
      [schema],
    );
    for (const state of NON_FINAL_STATES) expect(rows[0]?.indexdef).toContain(`'${state}'`);
    // `release` cascades by `id`, which the `(scope, id)` primary key can't look up.
    const byId = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'spend_reservation_scopes'",
      [schema],
    );
    expect(byId.rows.map((row) => row.indexdef)).toContainEqual(expect.stringMatching(/\(id\)$/));
    // A listing's `type` filter, matched or not, would otherwise scan the whole catalog twice.
    const catalog = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'catalog'",
      [schema],
    );
    expect(catalog.rows.map((row) => row.indexdef)).toContainEqual(
      expect.stringMatching(/\(type, seq\)$/),
    );
  });

  it("applies the migrations once when two runs race", async () => {
    const fresh = `${schema}_m`;
    await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    await pool.query(`CREATE SCHEMA ${fresh}`);
    const racing = poolFor(fresh, 2);
    try {
      const runs = await Promise.all([migrate(racing), migrate(racing)]);
      expect(runs).toContainEqual(MIGRATIONS.map((migration) => migration.name));
      expect(runs).toContainEqual([]);
    } finally {
      await racing.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    }
  });

  it("migrates through pnpm migrate's entry, once", async () => {
    const fresh = `${schema}_main`;
    await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    await pool.query(`CREATE SCHEMA ${fresh}`);
    try {
      await migrateMain({ DATABASE_URL: urlFor(fresh) });
      await migrateMain({ DATABASE_URL: urlFor(fresh) });
      const { rows } = await pool.query<{ name: string }>(
        `SELECT name FROM ${fresh}.schema_migrations ORDER BY name`,
      );
      expect(rows.map((row) => row.name)).toEqual(MIGRATIONS.map((migration) => migration.name));
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    }
  });

  it("reads records on a database `0002_success_answered` hasn't reached", async () => {
    // A release started before `pnpm migrate`: `SELECT s.*` has no `success_answered_at`.
    const fresh = `${schema}_0001`;
    await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    await pool.query(`CREATE SCHEMA ${fresh}`);
    const old = poolFor(fresh, 2);
    try {
      expect(await migrate(old, 0, MIGRATIONS.slice(0, 1))).toEqual(["0001_init"]);
      const { settlements } = postgresStores(old);
      const s = settlement("1");
      await settlements.claim(s);
      expect(await settlements.get(s.key)).not.toHaveProperty("successAnsweredAt");
    } finally {
      await old.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    }
  });

  it("adds the catalog's type index to a database past 0002, or one that has it", async () => {
    // A database `migrate` brought to 0002 before 0032 gets the index from 0003; one built from
    // 0032's branch, whose `0001_init` carried it, takes 0003 without an error.
    const typeIndex = async (on: pg.Pool) =>
      (
        await on.query(
          "SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'catalog_type_seq'",
        )
      ).rowCount;
    for (const built of ["develop", "branch"]) {
      const fresh = `${schema}_0002_${built}`;
      await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
      await pool.query(`CREATE SCHEMA ${fresh}`);
      const old = poolFor(fresh, 1);
      try {
        await migrate(old, 0, MIGRATIONS.slice(0, 2));
        if (built === "branch")
          await old.query("CREATE INDEX catalog_type_seq ON catalog (type, seq)");
        expect(await typeIndex(old), built).toBe(built === "branch" ? 1 : 0);
        expect(await migrate(old), built).toEqual([
          "0003_catalog_type_seq",
          "0004_spend_window",
          "0005_settlement_attempts",
        ]);
        expect(await typeIndex(old), built).toBe(1);
      } finally {
        await old.end();
        await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
      }
    }
  });

  it("copies each reservation's time and amount to its scopes on a database that has some", async () => {
    // Written by a release before `0004_spend_window`: the reservation and its scope rows only.
    const fresh = `${schema}_0003`;
    await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    await pool.query(`CREATE SCHEMA ${fresh}`);
    const old = poolFor(fresh, 2);
    try {
      expect(await migrate(old, 0, MIGRATIONS.slice(0, 3))).toHaveLength(3);
      await old.query(
        `INSERT INTO spend_reservations (id, amount, at, state) VALUES ('a', 60, 5, 'committed');
         INSERT INTO spend_reservation_scopes (id, scope) VALUES ('a', 'global'), ('a', 'payer:P')`,
      );
      expect(await migrate(old)).toEqual(["0004_spend_window", "0005_settlement_attempts"]);
      const { rows } = await old.query(
        "SELECT scope, at, amount FROM spend_reservation_scopes ORDER BY scope",
      );
      expect(rows).toEqual([
        { scope: "global", at: "5", amount: "60" },
        { scope: "payer:P", at: "5", amount: "60" },
      ]);
      expect(await postgresStores(old).spend.used("payer:P", 10, 6)).toBe(60n);
    } finally {
      await old.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    }
  });

  it("sums a window from the scope rows' covering index, without reading the reservations", async () => {
    const { spend } = await stores();
    const limits = [{ scope: "global" as const, maxStroops: 1_000n, windowMs: 100 }];
    await spend.reserve({ id: "a", amount: 60n, limits, now: 0 });
    await spend.commit("a", 20n);
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'spend_reservation_scopes_window'",
      [schema],
    );
    expect(rows[0]?.indexdef).toMatch(/\(scope, at\) INCLUDE \(amount\)$/);
    // The sum runs under the global scope's lock: it must not wait on anything that writes or
    // prunes `spend_reservations`.
    await holding(async (client) => {
      await client.query("LOCK TABLE spend_reservations IN ACCESS EXCLUSIVE MODE");
      // A sum that waits fails here, and the rollback then lets it finish.
      const blocked = new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000));
      expect(await Promise.race([spend.used("global", 100, 50), blocked])).toBe(20n);
    });
  });

  it("prunes a reservation with its scope rows, and skips rows another transaction holds", async () => {
    const { spend } = await stores();
    const limits = [
      { scope: "global" as const, maxStroops: 1_000n, windowMs: 100 },
      { scope: "payer:P" as const, maxStroops: 1_000n, windowMs: 100 },
    ];
    await spend.reserve({ id: "a", amount: 10n, limits, now: 1 });
    await spend.reserve({ id: "b", amount: 10n, limits, now: 2 });
    await holding(async (client) => {
      // A commit or release in flight on `a`: the pruner takes `b` and doesn't wait on `a`.
      await client.query("SELECT 1 FROM spend_reservations WHERE id = 'a' FOR UPDATE");
      const blocked = new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000));
      expect(await Promise.race([spend.prune(10, 10), blocked])).toBe(1);
    });
    const { rows } = await pool.query(
      "SELECT id, scope FROM spend_reservation_scopes ORDER BY scope",
    );
    expect(rows).toEqual([
      { id: "a", scope: "global" },
      { id: "a", scope: "payer:P" },
    ]);
  });

  it("prunes rate-limit windows without waiting on a key a hit holds", async () => {
    const { rateLimits } = await stores();
    await rateLimits.hit("a", 1_000, 0);
    await rateLimits.hit("b", 1_000, 0);
    await holding(async (client) => {
      await client.query("SELECT 1 FROM rate_limits WHERE key = 'a' FOR UPDATE");
      const blocked = new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000));
      expect(await Promise.race([rateLimits.prune(5_000, 10), blocked])).toBe(1);
    });
  });

  it("rolls back a whole run when one migration fails, then applies it again", async () => {
    const fresh = `${schema}_fail`;
    await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    await pool.query(`CREATE SCHEMA ${fresh}`);
    const migrating = poolFor(fresh, 1);
    const first = { name: "0001_first", sql: "CREATE TABLE first (id int)" };
    const broken = { name: "0002_broken", sql: "SELECT 1 / 0" };
    try {
      await expect(migrate(migrating, 0, [first, broken])).rejects.toThrow(/division by zero/);
      const { rows } = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1",
        [fresh],
      );
      // Neither the first migration's table nor `schema_migrations` survived.
      expect(rows).toEqual([]);
      expect(await migrate(migrating, 0, [first])).toEqual(["0001_first"]);
    } finally {
      await migrating.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    }
  });

  it("stores the catalog key version", async () => {
    const { catalog } = await stores();
    await catalog.upsert(catalogEntry());
    const { rows } = await pool.query("SELECT key_version FROM catalog");
    expect(rows).toEqual([{ key_version: CATALOG_KEY_VERSION }]);
  });
});
