import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { createPool, postgresStores } from "../src/adapters/postgres.js";
import { migrate } from "../src/adapters/postgres-schema.js";
import type { Stores } from "../src/ports/index.js";

/** The repo's `compose.yaml` database, used when `TEST_DATABASE_URL` is not set. */
const COMPOSE_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:54320/postgres";

export interface TestDatabase {
  /** This file's schema, migrated in `beforeAll`. */
  schema: string;
  /** A pool on this file's schema. */
  pool: pg.Pool;
  /** The names `migrate` applied to the schema. */
  applied: string[];
  /** Stores on `pool`. */
  stores: () => Stores;
  /** Empties every table: `beforeEach(db.empty)` gives each test empty stores. */
  empty: () => Promise<void>;
  /** The test database's URL, its connections using `searchPath` and any further `options`. */
  urlFor: (searchPath: string, options?: string) => string;
  /** A pool whose connections use `searchPath`. */
  poolFor: (searchPath: string, max: number, options?: string) => pg.Pool;
}

/**
 * A migrated schema of this test file's own in the test database: `TEST_DATABASE_URL`, else the
 * repo's compose database (`docker compose up -d`). Files run in parallel, so each gets its own
 * schema. Without a database every test of the file fails, naming the address it tried.
 */
export function testDatabase(max = 10): TestDatabase {
  const base = process.env.TEST_DATABASE_URL ?? COMPOSE_DATABASE_URL;
  const schema = `x402_test_${randomBytes(4).toString("hex")}`;
  const urlFor = (searchPath: string, options = "") => {
    const url = new URL(base);
    url.searchParams.set("options", `-c search_path=${searchPath} ${options}`.trim());
    return url.toString();
  };
  const poolFor = (searchPath: string, poolMax: number, options?: string) =>
    createPool(urlFor(searchPath, options), () => {}, poolMax);
  let truncate = "";
  const db: TestDatabase = {
    schema,
    pool: poolFor(schema, max),
    applied: [],
    stores: () => postgresStores(db.pool),
    empty: async () => {
      await db.pool.query(truncate);
    },
    urlFor,
    poolFor,
  };

  beforeAll(async () => {
    await createSchema(db.pool, schema, base);
    db.applied = await migrate(db.pool);
    const { rows } = await db.pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = $1 AND tablename <> 'schema_migrations' ORDER BY tablename`,
      [schema],
    );
    truncate = `TRUNCATE ${rows.map((row) => row.tablename).join(", ")} RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    try {
      // Empty when `beforeAll` found no database: there is no schema to drop.
      if (truncate) await db.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await db.pool.end();
    }
  });

  return db;
}

/** Creates `schema`, or fails naming the database's address and how to start one. */
export async function createSchema(pool: pg.Pool, schema: string, url: string): Promise<void> {
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    throw new Error(
      `no PostgreSQL for the tests at ${new URL(url).host}: run \`docker compose up -d\` at the repo root, or set TEST_DATABASE_URL`,
      { cause: error },
    );
  }
}
