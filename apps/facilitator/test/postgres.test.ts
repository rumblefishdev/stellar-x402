import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, postgresStores } from "../src/adapters/postgres.js";
import { MIGRATIONS, migrate } from "../src/adapters/postgres-schema.js";
import { NON_FINAL_STATES } from "../src/adapters/rules.js";
import { migrateMain } from "../src/main.js";
import type { Stores } from "../src/ports/index.js";
import {
  catalogStoreContract,
  rateLimitStoreContract,
  settlementStoreContract,
  spendStoreContract,
} from "./port-contracts.js";

/**
 * The contract suites against a real PostgreSQL, set by `TEST_DATABASE_URL`. Skipped only when
 * neither it nor `CI` is set. Each run gets its own schema, so runs never share tables.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL && !process.env.CI)("PostgreSQL stores", () => {
  const schema = `x402_test_${process.pid}`;
  let pool: pg.Pool;
  let connections = 0;
  let applied: string[];
  let truncate: string;

  /** The test database's URL, its connections using `searchPath`. */
  const urlFor = (searchPath: string) => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base) throw new Error("TEST_DATABASE_URL is required to run the PostgreSQL stores");
    const url = new URL(base);
    url.searchParams.set("options", `-c search_path=${searchPath}`);
    return url.toString();
  };
  /** A pool whose connections use `searchPath`. */
  const poolFor = (searchPath: string, max: number) =>
    createPool(urlFor(searchPath), () => {}, max);

  beforeAll(async () => {
    // More connections than the contracts' 10-way concurrent cases, so each runs on its own.
    pool = poolFor(schema, 20);
    pool.on("connect", () => connections++);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    applied = await migrate(pool);
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = $1 AND tablename <> 'schema_migrations' ORDER BY tablename`,
      [schema],
    );
    truncate = `TRUNCATE ${rows.map((row) => row.tablename).join(", ")} RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  const stores = async (): Promise<Stores> => {
    await pool.query(truncate);
    return postgresStores(pool);
  };

  settlementStoreContract(async () => (await stores()).settlements);
  spendStoreContract(async () => (await stores()).spend);
  rateLimitStoreContract(async () => (await stores()).rateLimits);
  catalogStoreContract(async () => (await stores()).catalog);

  it("ran the concurrent cases on separate connections", () => {
    expect(connections).toBeGreaterThanOrEqual(10);
  });

  it("applies every migration once, in order", async () => {
    expect(applied).toEqual(MIGRATIONS.map((migration) => migration.name));
    expect(await migrate(pool)).toEqual([]);
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'settlements_non_final'",
      [schema],
    );
    for (const state of NON_FINAL_STATES) expect(rows[0]?.indexdef).toContain(`'${state}'`);
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

  it("stores the catalog key version", async () => {
    const { catalog } = await stores();
    await catalog.upsert({
      key: {
        network: "stellar:testnet",
        payTo: "GPAYTO",
        method: "GET",
        resourceUrl: "https://seller.example/data",
      },
      keyVersion: CATALOG_KEY_VERSION,
      ledger: 1,
      resource: {
        resource: "https://seller.example/data",
        type: "http",
        x402Version: 2,
        accepts: [],
        lastUpdated: "2026-10-08T00:00:00.000Z",
      },
    });
    const { rows } = await pool.query("SELECT key_version FROM catalog");
    expect(rows).toEqual([{ key_version: CATALOG_KEY_VERSION }]);
  });
});
