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
  STELLAR_X402_DAILY_BUDGET: "200000",
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

  it("browses only when the payment settings are left empty and no key is given", () => {
    const config = loadConfig({
      ...BASE,
      STELLAR_X402_MAX_PER_CALL: "",
      STELLAR_X402_DAILY_BUDGET: "",
      STELLAR_X402_STATE_DIR: "",
    });
    expect(config).toEqual(loadConfig(BASE));
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
    expect(config.payment?.payer).toBe(BUYER.publicKey());
    expect(config.payment?.schemes.map((s) => s.network)).toEqual(["stellar:testnet"]);
    expect(config.payment?.assets).toEqual({
      [USDC_TESTNET_ADDRESS]: { maxPerCall: 10_000n, daily: 200_000n },
    });
  });

  it("records the daily budget in the home directory unless a directory is named", () => {
    expect(loadConfig(PAYING).payment?.dailyDir).toBe(join(homedir(), ".stellar-x402-mcp"));
    const named = loadConfig({ ...PAYING, STELLAR_X402_STATE_DIR: "/var/tmp/x402" });
    expect(named.payment?.dailyDir).toBe("/var/tmp/x402");
    const home = loadConfig({ ...PAYING, STELLAR_X402_STATE_DIR: "~/.x402" });
    expect(home.payment?.dailyDir).toBe(join(homedir(), ".x402"));
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
      "a key without a daily budget",
      { ...PAYING, STELLAR_X402_DAILY_BUDGET: undefined },
      "STELLAR_X402_DAILY_BUDGET is required",
    ],
    [
      "the per-process budget, replaced by the daily one",
      { ...PAYING, STELLAR_X402_BUDGET: "50000" },
      "STELLAR_X402_BUDGET is not a setting of this server; it was replaced by STELLAR_X402_DAILY_BUDGET",
    ],
    [
      "a limit in USDC instead of atomic units",
      { ...PAYING, STELLAR_X402_MAX_PER_CALL: "0.5" },
      "atomic units",
    ],
    [
      "a daily budget in USDC instead of atomic units",
      { ...PAYING, STELLAR_X402_DAILY_BUDGET: "1.5" },
      "STELLAR_X402_DAILY_BUDGET must be an amount in atomic units",
    ],
    [
      "a per-call limit without a key",
      { ...BASE, STELLAR_X402_MAX_PER_CALL: "10000" },
      "STELLAR_X402_MAX_PER_CALL needs STELLAR_X402_SECRET_KEY",
    ],
    [
      "a daily budget without a key",
      { ...BASE, STELLAR_X402_DAILY_BUDGET: "200000" },
      "STELLAR_X402_DAILY_BUDGET needs STELLAR_X402_SECRET_KEY",
    ],
    [
      "a state directory without a key",
      { ...BASE, STELLAR_X402_STATE_DIR: "/var/tmp/x402" },
      "STELLAR_X402_STATE_DIR needs STELLAR_X402_SECRET_KEY",
    ],
    [
      "another user's home directory",
      { ...PAYING, STELLAR_X402_STATE_DIR: "~alice/.x402" },
      "STELLAR_X402_STATE_DIR must be an absolute path or start with ~/",
    ],
    [
      "a relative state directory",
      { ...PAYING, STELLAR_X402_STATE_DIR: "state" },
      "STELLAR_X402_STATE_DIR must be an absolute path",
    ],
    [
      "the state file, replaced by a state directory",
      { ...PAYING, STELLAR_X402_STATE_FILE: "/var/tmp/spent.json" },
      "STELLAR_X402_STATE_FILE is not a setting of this server; it was replaced by STELLAR_X402_STATE_DIR",
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
