import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACCOUNT_PLANS, parseAccountPlans } from "@stellar-x402/api-keys";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, parseHubSecret } from "../src/config.js";

const SEALING = Buffer.alloc(32, 2).toString("base64");
// Bytes 1..32.
const CURRENT = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
const PREVIOUS = Buffer.alloc(32, 7).toString("base64");
const HUB = JSON.stringify({ current: CURRENT });
const HUB_PROBLEM =
  'HUB_TOKEN_SECRET must be JSON {"current", "previous"?}, each standard padded base64 of 32 bytes';

const ENV = {
  HUB_TOKEN_SECRET: HUB,
  KEY_ENCRYPTION_KEY: SEALING,
  DATABASE_URL: "postgres://portal:password@postgres-mainnet:5432/x402",
};

const problems = (env: Record<string, string | undefined>): string[] => {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
};

describe("the hub's secret", () => {
  it("is a current secret of 32 bytes, and a previous one while it rotates", () => {
    const only = parseHubSecret(HUB);
    expect(only?.current).toEqual(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)));
    expect(only?.previous).toBeUndefined();
    const both = parseHubSecret(JSON.stringify({ current: CURRENT, previous: PREVIOUS }));
    expect(both?.current).toHaveLength(32);
    expect(both?.previous).toEqual(Buffer.alloc(32, 7));
  });

  it.each([
    ["not JSON", "AQIDBAUG"],
    ["an array", JSON.stringify([CURRENT])],
    ["a string", JSON.stringify(CURRENT)],
    ["another key", JSON.stringify({ current: CURRENT, next: PREVIOUS })],
    ["no current", JSON.stringify({ previous: PREVIOUS })],
    ["31 bytes", JSON.stringify({ current: Buffer.alloc(31).toString("base64") })],
    ["33 bytes", JSON.stringify({ current: Buffer.alloc(33).toString("base64") })],
    ["a bad previous", JSON.stringify({ current: CURRENT, previous: "AQID" })],
    ["base64url", JSON.stringify({ current: Buffer.alloc(32, 251).toString("base64url") })],
    ["unpadded base64", JSON.stringify({ current: CURRENT.slice(0, -1) })],
    ["a trailing bit set", JSON.stringify({ current: CURRENT.replace("HyA=", "HyB=") })],
  ])("refuses %s", (_name, text) => {
    expect(parseHubSecret(text)).toBeUndefined();
    expect(problems({ ...ENV, HUB_TOKEN_SECRET: text })).toEqual([HUB_PROBLEM]);
  });
});

describe("the config", () => {
  it("reads the settings, with the defaults of the rest", () => {
    expect(parseConfig(ENV)).toEqual({
      port: 4022,
      hubSecret: { current: Buffer.from(CURRENT, "base64") },
      keyEncryptionKey: Buffer.alloc(32, 2),
      databaseUrl: ENV.DATABASE_URL,
      minAccountAgeMinutes: 5,
      clientIp: "socket",
      accountPlans: parseAccountPlans(DEFAULT_ACCOUNT_PLANS),
      logLevel: "info",
    });
  });

  it("takes the account plans as the facilitator does, and refuses text it would", () => {
    expect(
      parseConfig({ ...ENV, ACCOUNT_PLANS: "free:5:10,pro:50:100" }).accountPlans.get("pro"),
    ).toEqual({ name: "pro", payments: 50, dailyFeeStroops: 100n });
    for (const text of ["basic:1:1", "free:0:1", "free:1:1,free:2:2", "free"]) {
      const found = problems({ ...ENV, ACCOUNT_PLANS: text });
      expect(found).toEqual([expect.stringContaining("ACCOUNT_PLANS must be")]);
    }
    // The entry that is wrong is not echoed back.
    const found = problems({ ...ENV, ACCOUNT_PLANS: "free:1000:2000,Odd_Name:7:xyz" });
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain("Odd_Name");
  });

  it("takes the optional settings", () => {
    expect(
      parseConfig({
        ...ENV,
        HUB_TOKEN_SECRET: JSON.stringify({ current: CURRENT, previous: PREVIOUS }),
        PORT: "8080",
        MIN_ACCOUNT_AGE_MINUTES: "0",
        CLIENT_IP: "cloudflare",
        LOG_LEVEL: "debug",
      }),
    ).toMatchObject({
      port: 8080,
      hubSecret: { previous: Buffer.alloc(32, 7) },
      minAccountAgeMinutes: 0,
      clientIp: "cloudflare",
      logLevel: "debug",
    });
  });

  it("ignores the settings of the sign-in it no longer has", () => {
    expect(
      problems({
        ...ENV,
        DISCORD_CLIENT_ID: "x402 Facilitator",
        DISCORD_CLIENT_SECRET: "old",
        SESSION_SECRET: "short",
        PUBLIC_URL: "not a url",
        WEB_URL: "http://sorobanscan.com/",
      }),
    ).toEqual([]);
  });

  it("names every missing setting at once", () => {
    expect(problems({})).toEqual([
      "KEY_ENCRYPTION_KEY is required",
      "HUB_TOKEN_SECRET is required",
      "DATABASE_URL is required",
    ]);
    // Blank is unset.
    expect(problems({ ...ENV, DATABASE_URL: "  " })).toEqual(["DATABASE_URL is required"]);
  });

  it.each([
    [{ MIN_ACCOUNT_AGE_MINUTES: "five" }, "MIN_ACCOUNT_AGE_MINUTES must be a whole number"],
    [{ MIN_ACCOUNT_AGE_MINUTES: "-1" }, "MIN_ACCOUNT_AGE_MINUTES must be a whole number"],
    [{ MIN_ACCOUNT_AGE_MINUTES: "525601" }, "MIN_ACCOUNT_AGE_MINUTES must be a whole number"],
    [{ PORT: "0" }, "PORT must be a whole number"],
    [{ PORT: "70000" }, "PORT must be a whole number"],
    [{ CLIENT_IP: "x-forwarded-for" }, "CLIENT_IP must be one of socket, cloudflare"],
    [{ LOG_LEVEL: "verbose" }, "LOG_LEVEL must be one of"],
    [{ KEY_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64") }, "KEY_ENCRYPTION_KEY must be 32"],
    [{ KEY_ENCRYPTION_KEY: Buffer.alloc(33).toString("base64") }, "KEY_ENCRYPTION_KEY must be 32"],
  ])("refuses %j", (change, problem) => {
    const found = problems({ ...ENV, ...change });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(problem);
  });

  it("keeps the hub's secret and the sealing key apart, whichever of the two is equal", () => {
    const must = ["HUB_TOKEN_SECRET and KEY_ENCRYPTION_KEY must differ"];
    expect(problems({ ...ENV, KEY_ENCRYPTION_KEY: CURRENT })).toEqual(must);
    expect(
      problems({
        ...ENV,
        HUB_TOKEN_SECRET: JSON.stringify({ current: PREVIOUS, previous: SEALING }),
      }),
    ).toEqual(must);
  });

  it("never repeats a value in what it reports", () => {
    const error = (() => {
      try {
        parseConfig({
          ...ENV,
          HUB_TOKEN_SECRET: '{"current":"sekret-huba"}',
          KEY_ENCRYPTION_KEY: "sekret-klucza",
        });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("the config was taken");
    })();
    expect(`${error.message} ${error.problems.join(" ")}`).not.toMatch(/sekret/);
  });

  it("reads a secret from the file a deploy names, trimmed", () => {
    const dir = mkdtempSync(join(tmpdir(), "portal-config-"));
    const file = (name: string, content: string) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    };
    const env = {
      ...ENV,
      DATABASE_URL: undefined,
      DATABASE_URL_FILE: file("database-url", "postgres://from-file/x402\n"),
      HUB_TOKEN_SECRET: undefined,
      HUB_TOKEN_SECRET_FILE: file("hub", `${HUB}\n`),
      KEY_ENCRYPTION_KEY: undefined,
      KEY_ENCRYPTION_KEY_FILE: file("sealing", `${SEALING}\n`),
    };
    expect(parseConfig(env)).toMatchObject({
      databaseUrl: "postgres://from-file/x402",
      hubSecret: { current: Buffer.from(CURRENT, "base64") },
      keyEncryptionKey: Buffer.alloc(32, 2),
    });

    expect(problems({ ...env, HUB_TOKEN_SECRET: HUB })).toEqual([
      "HUB_TOKEN_SECRET and HUB_TOKEN_SECRET_FILE must not both be set",
    ]);
    expect(problems({ ...env, HUB_TOKEN_SECRET_FILE: join(dir, "missing") })).toEqual([
      "HUB_TOKEN_SECRET_FILE can't be read (ENOENT)",
      "HUB_TOKEN_SECRET is required",
    ]);
    expect(problems({ ...env, HUB_TOKEN_SECRET_FILE: file("empty", " \n") })).toEqual([
      "HUB_TOKEN_SECRET_FILE is empty",
      "HUB_TOKEN_SECRET is required",
    ]);
  });
});
