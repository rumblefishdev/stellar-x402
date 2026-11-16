import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/adapters/postgres-schema.js";
import { ConfigError } from "../src/config.js";
import { apiKeyHash } from "../src/http/api-key.js";
import { KeysError, keysMain } from "../src/main.js";
import { testDatabase } from "./database.js";

const db = testDatabase();
beforeEach(db.empty);

/** Runs the script on the test database and resolves what it printed, line by line. */
async function keys(...argv: string[]): Promise<string[]> {
  const lines: string[] = [];
  await keysMain(argv, { DATABASE_URL: db.urlFor(db.schema) }, (line) => lines.push(line));
  return lines;
}

/** The key `issue` printed. */
const keyOf = (lines: string[]): string => {
  const key = lines.find((line) => line.startsWith("key: "))?.slice("key: ".length);
  if (!key) throw new Error(`no key in: ${lines.join(" | ")}`);
  return key;
};

/** Every row of the registry, each as one JSON text: what a dump of the table would show. */
const rows = async (): Promise<string[]> =>
  (
    await db.pool.query<{ row: string }>(
      "SELECT row_to_json(api_keys)::text AS row FROM api_keys ORDER BY created_at, key_hash",
    )
  ).rows.map(({ row }) => row);

describe("the operator's API key script (0105)", () => {
  it("issues an operator a key, prints it once, and stores only its hash", async () => {
    const printed = await keys("issue", "acme-weather");
    const key = keyOf(printed);
    expect(key).toMatch(/^x402_[A-Za-z0-9_-]{43}$/);
    expect(printed).toContain("owner: operator:acme-weather");
    // Once: no other line repeats it.
    expect(printed.filter((line) => line.includes(key))).toHaveLength(1);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!)).toEqual({
      key_hash: apiKeyHash(key),
      owner: "operator:acme-weather",
      state: "active",
      created_at: expect.any(Number),
      revoked_at: null,
    });
    // Neither the key nor the part of it after the prefix is anywhere in the row.
    expect(stored[0]).not.toContain(key);
    expect(stored[0]).not.toContain(key.slice("x402_".length));
    expect(await db.stores().apiKeys.ownerOf(apiKeyHash(key))).toBe("operator:acme-weather");
  });

  it("gives every issue a new key", async () => {
    const first = keyOf(await keys("issue", "a"));
    const second = keyOf(await keys("issue", "b"));
    expect(second).not.toBe(first);
  });

  it("refuses a second key for an owner that has an active one, and stores nothing", async () => {
    await keys("issue", "acme");
    const before = await rows();
    await expect(keys("issue", "acme")).rejects.toThrow(
      new KeysError("operator:acme has an active key: revoke it first"),
    );
    expect(await rows()).toEqual(before);
  });

  it("revokes an owner's key, after which the owner can be issued a new one", async () => {
    const first = keyOf(await keys("issue", "acme"));
    expect(await keys("revoke", "acme")).toEqual(["revoked: operator:acme"]);
    const { apiKeys } = db.stores();
    expect(await apiKeys.ownerOf(apiKeyHash(first))).toBeUndefined();
    await expect(keys("revoke", "acme")).rejects.toThrow(
      new KeysError("operator:acme has no active key"),
    );

    const second = keyOf(await keys("issue", "acme"));
    expect(await apiKeys.ownerOf(apiKeyHash(second))).toBe("operator:acme");
    expect(await apiKeys.ownerOf(apiKeyHash(first))).toBeUndefined();
    expect((await apiKeys.list()).map((key) => key.state)).toEqual(["revoked", "active"]);
  });

  it("revokes a key the portal issued, named by its whole owner", async () => {
    const { apiKeys } = db.stores();
    await apiKeys.issue({ hash: "a".repeat(64), owner: "discord:412345678901234567", now: 1 });
    expect(await keys("revoke", "discord:412345678901234567")).toEqual([
      "revoked: discord:412345678901234567",
    ]);
    expect(await apiKeys.ownerOf("a".repeat(64))).toBeUndefined();
  });

  it("lists every key with its owner, state and times, oldest first, and no key", async () => {
    expect(await keys("list")).toEqual(["no keys"]);
    const first = keyOf(await keys("issue", "acme"));
    await keys("revoke", "acme");
    const second = keyOf(await keys("issue", "acme"));
    const listed = await keys("list");
    expect(listed).toHaveLength(2);
    const iso = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";
    expect(listed[0]).toMatch(
      new RegExp(
        `^operator:acme\\trevoked\\tissued ${iso}\\trevoked ${iso}\\tsha256 [0-9a-f]{12}$`,
      ),
    );
    expect(listed[1]).toMatch(
      new RegExp(`^operator:acme\\tactive\\tissued ${iso}\\t-\\tsha256 [0-9a-f]{12}$`),
    );
    // The start of each hash tells two keys of one owner apart.
    expect(listed[0]).toContain(apiKeyHash(first).slice(0, 12));
    expect(listed[1]).toContain(apiKeyHash(second).slice(0, 12));
    for (const key of [first, second]) expect(listed.join("\n")).not.toContain(key);
  });

  it.each([
    [["issue"], "no name"],
    [["issue", ""], "an empty name"],
    [["issue", "Acme"], "an upper-case name"],
    [["issue", "acme weather"], "a name with a space"],
    [["issue", "-acme"], "a name that starts with a hyphen"],
    [["issue", "a".repeat(120)], "a name too long for an owner"],
    [["issue", "discord:412345678901234567"], "a portal owner: only the portal issues those"],
    [["issue", "operator:acme"], "a name that already carries the prefix"],
    [["issue", "acme", "extra"], "an argument too many"],
    [["revoke"], "no owner"],
    [["revoke", "Acme"], "an owner that can't be in the registry"],
    [["revoke", "acme", "extra"], "an argument too many"],
    [["list", "extra"], "an argument too many"],
    [["rotate", "acme"], "a command it doesn't have"],
    [[], "no command"],
  ])("refuses %j (%s) with its usage, before it connects", async (argv) => {
    // No `DATABASE_URL`: a usage error must not need one.
    const error = await keysMain(argv, {}, () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeysError);
    expect((error as KeysError).message).toMatch(/^usage:/);
    expect(await rows()).toEqual([]);
  });

  it("names the missing setting when DATABASE_URL isn't set", async () => {
    const error = await keysMain(["list"], {}, () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems.join(" ")).toContain("DATABASE_URL");
  });

  it("refuses to run on a schema without the registry, naming the migrations it lacks", async () => {
    const fresh = `${db.schema}_keys_behind`;
    await db.pool.query(`CREATE SCHEMA ${fresh}`);
    const pool = db.poolFor(fresh, 1);
    try {
      const before = MIGRATIONS.findIndex((migration) => migration.name === "0013_api_keys");
      await migrate(pool, 0, MIGRATIONS.slice(0, before));
      const lacks = MIGRATIONS.slice(before).map((migration) => migration.name);
      await expect(
        keysMain(["issue", "acme"], { DATABASE_URL: db.urlFor(fresh) }, () => {}),
      ).rejects.toThrow(new KeysError(`the schema lacks migrations: ${lacks.join(", ")}`));
    } finally {
      await pool.end();
      await db.pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    }
  });
});
