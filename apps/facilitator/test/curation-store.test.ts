import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { createPostgresCurationStore } from "../src/adapters/postgres-curation.js";
import { testDatabase } from "./database.js";

const PAY_TO = Keypair.random().publicKey();
const OTHER_PAY_TO = Keypair.random().publicKey();
/** App clock ms past what a 32-bit integer holds. */
const CHECKED_AT = Date.parse("2026-11-27T10:00:00Z");

describe("PostgreSQL curation store", () => {
  const db = testDatabase();
  beforeEach(db.empty);

  const key = { network: "stellar:testnet" as const, host: "pogoda.pl", payTo: PAY_TO };

  it("has no record of a key never put", async () => {
    const store = createPostgresCurationStore(db.pool);
    expect(await store.get(key)).toBeUndefined();
  });

  it("gets the record put", async () => {
    const store = createPostgresCurationStore(db.pool);
    await store.put({ ...key, curated: true, checkedAt: CHECKED_AT });
    expect(await store.get(key)).toEqual({ ...key, curated: true, checkedAt: CHECKED_AT });
  });

  it("keeps a record whose check never finished, its checkedAt null", async () => {
    const store = createPostgresCurationStore(db.pool);
    await store.put({ ...key, curated: false, checkedAt: null });
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: null });
  });

  it("replaces the record of the same key", async () => {
    const store = createPostgresCurationStore(db.pool);
    await store.put({ ...key, curated: true, checkedAt: CHECKED_AT });
    await store.put({ ...key, curated: false, checkedAt: CHECKED_AT + 1_000 });
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: CHECKED_AT + 1_000 });
  });

  it.each([
    ["network", { ...key, network: "stellar:pubnet" as const }],
    ["host", { ...key, host: "pogoda.com" }],
    ["payTo", { ...key, payTo: OTHER_PAY_TO }],
  ])("keeps a key apart from one of another %s", async (_name, other) => {
    const store = createPostgresCurationStore(db.pool);
    await store.put({ ...key, curated: true, checkedAt: CHECKED_AT });
    expect(await store.get(other)).toBeUndefined();
    await store.put({ ...other, curated: false, checkedAt: null });
    expect(await store.get(key)).toEqual({ ...key, curated: true, checkedAt: CHECKED_AT });
    expect(await store.get(other)).toEqual({ ...other, curated: false, checkedAt: null });
  });
});
