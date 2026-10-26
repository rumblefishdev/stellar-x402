import { describe, expect, it } from "vitest";
import { createPool } from "../src/adapters/postgres.js";
import { createSchema } from "./database.js";

describe("the test database", () => {
  it("fails without a database, naming the address and the command to run", async () => {
    // Port 1: nothing listens there.
    const url = "postgres://postgres:postgres@127.0.0.1:1/x";
    const pool = createPool(url, () => {}, 1);
    try {
      await expect(createSchema(pool, "x402_test_none", url)).rejects.toThrow(
        "no PostgreSQL for the tests at 127.0.0.1:1: run `docker compose up -d` at the repo root, or set TEST_DATABASE_URL",
      );
    } finally {
      await pool.end();
    }
  });
});
