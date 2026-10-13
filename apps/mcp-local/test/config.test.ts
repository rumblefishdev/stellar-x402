import { Keypair } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE = { STELLAR_X402_DISCOVERY_URL: "https://catalog.example.com" };
const BUYER = Keypair.random();
const PAYING = {
  ...BASE,
  STELLAR_X402_SECRET_KEY: BUYER.secret(),
  STELLAR_X402_MAX_PER_CALL: "10000",
  STELLAR_X402_BUDGET: "50000",
};

describe("loadConfig", () => {
  it("browses only, with the defaults, when no key is given", () => {
    expect(loadConfig(BASE)).toEqual({
      discoveryUrl: "https://catalog.example.com",
      timeoutMs: 30_000,
      maxResponseBytes: 100_000,
      allowInsecureLocal: false,
    });
  });

  it("uses the defaults for empty values", () => {
    const config = loadConfig({
      ...BASE,
      STELLAR_X402_TIMEOUT_MS: "",
      STELLAR_X402_MAX_RESPONSE_BYTES: "",
      STELLAR_X402_ALLOW_INSECURE_LOCAL: "",
    });
    expect(config).toEqual(loadConfig(BASE));
  });

  it("pays in testnet USDC within the limits when a key is given", () => {
    const config = loadConfig(PAYING);
    expect(config.buyer).toBe(BUYER.publicKey());
    expect(config.payment?.schemes.map((s) => s.network)).toEqual(["stellar:testnet"]);
    expect(config.payment?.assets).toEqual({
      [USDC_TESTNET_ADDRESS]: { maxPerCall: 10_000n, budget: 50_000n },
    });
  });

  it("keeps no daily record without a daily budget", () => {
    expect(loadConfig(PAYING).payment?.dailyFile).toBeUndefined();
  });

  it("adds a daily budget, recorded in the home directory unless a file is named", () => {
    const daily = { ...PAYING, STELLAR_X402_DAILY_BUDGET: "200000" };
    const config = loadConfig(daily);
    expect(config.payment?.assets[USDC_TESTNET_ADDRESS]).toEqual({
      maxPerCall: 10_000n,
      budget: 50_000n,
      daily: 200_000n,
    });
    expect(config.payment?.dailyFile).toBe(join(homedir(), ".stellar-x402-mcp", "spent.json"));
    const named = loadConfig({ ...daily, STELLAR_X402_STATE_FILE: "/var/tmp/spent.json" });
    expect(named.payment?.dailyFile).toBe("/var/tmp/spent.json");
  });

  it("reads the optional settings", () => {
    const config = loadConfig({
      ...BASE,
      STELLAR_X402_TIMEOUT_MS: "5000",
      STELLAR_X402_MAX_RESPONSE_BYTES: "2000",
      STELLAR_X402_ALLOW_INSECURE_LOCAL: "1",
    });
    expect(config).toMatchObject({
      timeoutMs: 5_000,
      maxResponseBytes: 2_000,
      allowInsecureLocal: true,
    });
  });

  it.each([
    ["no catalog URL", {}, "STELLAR_X402_DISCOVERY_URL is required"],
    [
      "a misspelt setting",
      { ...BASE, STELLAR_X402_TIMEOUT: "5000" },
      "STELLAR_X402_TIMEOUT is not a setting of this server",
    ],
    ["a timeout in exponent form", { ...BASE, STELLAR_X402_TIMEOUT_MS: "1e3" }, "positive integer"],
    ["a zero size limit", { ...BASE, STELLAR_X402_MAX_RESPONSE_BYTES: "0" }, "positive integer"],
    [
      "a catalog address that is not a URL",
      { STELLAR_X402_DISCOVERY_URL: "catalog.example.com" },
      "STELLAR_X402_DISCOVERY_URL must be a URL",
    ],
    ["pubnet", { ...BASE, STELLAR_X402_NETWORK: "stellar:pubnet" }, "stellar:testnet only"],
    [
      "a key without a per-call limit",
      { ...PAYING, STELLAR_X402_MAX_PER_CALL: "" },
      "STELLAR_X402_MAX_PER_CALL is required",
    ],
    [
      "a key without a budget",
      { ...PAYING, STELLAR_X402_BUDGET: undefined },
      "STELLAR_X402_BUDGET is required",
    ],
    [
      "a limit in USDC instead of atomic units",
      { ...PAYING, STELLAR_X402_BUDGET: "0.5" },
      "atomic units",
    ],
    [
      "a daily budget in USDC instead of atomic units",
      { ...PAYING, STELLAR_X402_DAILY_BUDGET: "1.5" },
      "STELLAR_X402_DAILY_BUDGET must be an amount in atomic units",
    ],
    [
      "a record file without a daily budget",
      { ...PAYING, STELLAR_X402_STATE_FILE: "/var/tmp/spent.json" },
      "STELLAR_X402_STATE_FILE needs STELLAR_X402_DAILY_BUDGET",
    ],
    [
      "a timeout that is not a number",
      { ...BASE, STELLAR_X402_TIMEOUT_MS: "30s" },
      "positive integer",
    ],
    [
      "an insecure-local switch that is not 0 or 1",
      { ...BASE, STELLAR_X402_ALLOW_INSECURE_LOCAL: "true" },
      "must be 0 or 1",
    ],
  ])("refuses to start with %s", (_, env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it("refuses a malformed key without repeating it", () => {
    const secret = `S${"A".repeat(55)}`;
    expect(() => loadConfig({ ...PAYING, STELLAR_X402_SECRET_KEY: secret })).toThrow(
      /^STELLAR_X402_SECRET_KEY is not a Stellar secret key\.$/,
    );
  });
});
