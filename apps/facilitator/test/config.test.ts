import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { type Config, ConfigError, parseConfig } from "../src/config.js";

const keypair = (byte: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte));
const SECRET = keypair(1).secret();
const CHANNEL_A = keypair(2).publicKey();
const CHANNEL_B = keypair(3).publicKey();

const minimal = { FACILITATOR_SECRET: SECRET, CHANNELS: `${CHANNEL_A}, ${CHANNEL_B}` };

function problems(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
  it("applies testnet defaults to a minimal environment", () => {
    expect(parseConfig(minimal)).toEqual<Config>({
      network: "stellar:testnet",
      port: 4021,
      logLevel: "info",
      rpcUrls: ["https://soroban-testnet.stellar.org"],
      facilitatorSecret: SECRET,
      channels: [CHANNEL_A, CHANNEL_B],
      store: "memory",
      fees: { maxFeeStroops: 250_000n, inclusionFeeStroops: undefined, escalation: undefined },
      settlement: {
        minValidityLedgers: 4,
        settleTimeoutMs: 30_000,
        settleBudgetMs: 90_000,
        leaseTtlMs: 30_000,
      },
      http: {
        bodyLimitBytes: 65_536,
        trustedProxyHops: 0,
        rateLimit: { windowMs: 60_000, verify: 120, settle: 60, discovery: 120 },
      },
      spend: {
        windowMs: 86_400_000,
        globalStroops: 5_000_000_000n,
        perPayerStroops: 50_000_000n,
        perPayToStroops: 500_000_000n,
        perAssetStroops: 2_000_000_000n,
        breakerFailures: 5,
        breakerCooldownMs: 600_000,
      },
      catalog: { allowHttp: false },
    });
  });

  it("maps every setting to its own field", () => {
    // Distinct values, so two settings swapped in the mapping would fail.
    const config = parseConfig({
      NETWORK: "stellar:pubnet",
      PORT: "8080",
      LOG_LEVEL: "debug",
      RPC_URLS: "https://a.example, https://b.example",
      FACILITATOR_SECRET: SECRET,
      CHANNELS: CHANNEL_B,
      STORE: "memory",
      MAX_FEE_STROOPS: "300001",
      INCLUSION_FEE_STROOPS: "201",
      FEE_ESCALATION_FACTOR: "1.5",
      FEE_ESCALATION_MAX_STROOPS: "1002",
      MIN_VALIDITY_LEDGERS: "13",
      SETTLE_TIMEOUT_MS: "31000",
      SETTLE_BUDGET_MS: "60000",
      LEASE_TTL_MS: "32000",
      BODY_LIMIT_BYTES: "70000",
      TRUSTED_PROXY_HOPS: "2",
      RATE_LIMIT_WINDOW_MS: "61000",
      RATE_LIMIT_VERIFY: "121",
      RATE_LIMIT_SETTLE: "62",
      RATE_LIMIT_DISCOVERY: "123",
      SPEND_WINDOW_MS: "3600000",
      SPEND_GLOBAL_STROOPS: "11",
      SPEND_PER_PAYER_STROOPS: "12",
      SPEND_PER_PAY_TO_STROOPS: "13",
      SPEND_PER_ASSET_STROOPS: "14",
      BREAKER_FAILURES: "7",
      BREAKER_COOLDOWN_MS: "5000",
    });
    expect(config).toEqual<Config>({
      network: "stellar:pubnet",
      port: 8080,
      logLevel: "debug",
      rpcUrls: ["https://a.example", "https://b.example"],
      facilitatorSecret: SECRET,
      channels: [CHANNEL_B],
      store: "memory",
      fees: {
        maxFeeStroops: 300_001n,
        inclusionFeeStroops: 201n,
        escalation: { factor: 1.5, max: 1002 },
      },
      settlement: {
        minValidityLedgers: 13,
        settleTimeoutMs: 31_000,
        settleBudgetMs: 60_000,
        leaseTtlMs: 32_000,
      },
      http: {
        bodyLimitBytes: 70_000,
        trustedProxyHops: 2,
        rateLimit: { windowMs: 61_000, verify: 121, settle: 62, discovery: 123 },
      },
      spend: {
        windowMs: 3_600_000,
        globalStroops: 11n,
        perPayerStroops: 12n,
        perPayToStroops: 13n,
        perAssetStroops: 14n,
        breakerFailures: 7,
        breakerCooldownMs: 5_000,
      },
      catalog: { allowHttp: false },
    });
  });

  it("trims values and treats blank ones as unset", () => {
    const config = parseConfig({
      FACILITATOR_SECRET: `${SECRET}\n`,
      CHANNELS: ` ${CHANNEL_A} `,
      RPC_URLS: "",
      PORT: " ",
    });
    expect(config.facilitatorSecret).toBe(SECRET);
    expect(config.channels).toEqual([CHANNEL_A]);
    expect(config.port).toBe(4021);
  });

  it("names missing required values", () => {
    expect(problems({})).toEqual(["FACILITATOR_SECRET is required", "CHANNELS is required"]);
  });

  it("names invalid values without echoing them", () => {
    const secret = `S${"A".repeat(55)}`; // right shape, bad checksum
    const found = problems({ ...minimal, FACILITATOR_SECRET: secret, LOG_LEVEL: "verbose-xyz" });
    expect(found).toEqual([
      "LOG_LEVEL must be one of debug, info, warn, error",
      "FACILITATOR_SECRET must be a Stellar secret key (S…)",
    ]);
    expect(found.join(" ")).not.toContain(secret);
    expect(found.join(" ")).not.toContain("verbose-xyz");
  });

  it("checks channel addresses", () => {
    expect(problems({ ...minimal, CHANNELS: `G${"A".repeat(55)}` })).toEqual([
      "CHANNELS must be Stellar account addresses (G…)",
    ]);
    expect(problems({ ...minimal, CHANNELS: `${CHANNEL_A},${CHANNEL_A}` })).toEqual([
      "CHANNELS must not repeat a channel",
    ]);
    expect(problems({ ...minimal, CHANNELS: "," })).toEqual([
      "CHANNELS must list at least one channel",
    ]);
  });

  it("accepts only plain decimal numbers in range", () => {
    expect(problems({ ...minimal, PORT: "0x10" })).toEqual(["PORT must be a whole number"]);
    expect(problems({ ...minimal, PORT: "70000" })).toEqual(["PORT must be between 1 and 65535"]);
    expect(problems({ ...minimal, SETTLE_TIMEOUT_MS: "1e20" })).toEqual([
      "SETTLE_TIMEOUT_MS must be a whole number",
    ]);
    expect(problems({ ...minimal, SETTLE_TIMEOUT_MS: "99999999999" })).toEqual([
      "SETTLE_TIMEOUT_MS must be between 1 and 2147483647",
    ]);
    expect(problems({ ...minimal, FEE_ESCALATION_FACTOR: "Infinity" })).toEqual([
      "FEE_ESCALATION_FACTOR must be a decimal number",
    ]);
    expect(problems({ ...minimal, FEE_ESCALATION_FACTOR: "1" })).toEqual([
      "FEE_ESCALATION_FACTOR must be above 1 and at most 100",
    ]);
    expect(problems({ ...minimal, INCLUSION_FEE_STROOPS: "99" })).toEqual([
      "INCLUSION_FEE_STROOPS must be at least 100",
    ]);
    // The pool keeps one spare ledger, so 1 lets `/verify` accept what `/settle` refuses.
    expect(problems({ ...minimal, MIN_VALIDITY_LEDGERS: "1" })).toEqual([
      "MIN_VALIDITY_LEDGERS must be at least 2",
    ]);
  });

  it("keeps twice the inclusion bid below the fee ceiling, as the fee bump pays it twice", () => {
    for (const bid of ["500", "999", "5000"]) {
      expect(problems({ ...minimal, MAX_FEE_STROOPS: "1000", INCLUSION_FEE_STROOPS: bid })).toEqual(
        ["INCLUSION_FEE_STROOPS must be below half of MAX_FEE_STROOPS"],
      );
    }
    expect(
      parseConfig({ ...minimal, MAX_FEE_STROOPS: "1000", INCLUSION_FEE_STROOPS: "499" }).fees,
    ).toMatchObject({ maxFeeStroops: 1000n, inclusionFeeStroops: 499n });
  });

  it("keeps twice the fee-stats floor below the fee ceiling without a fixed bid", () => {
    for (const max of ["100", "200"]) {
      expect(problems({ ...minimal, MAX_FEE_STROOPS: max })).toEqual([
        "MAX_FEE_STROOPS must be above 200, twice the fee-stats bid's floor",
      ]);
    }
    expect(parseConfig({ ...minimal, MAX_FEE_STROOPS: "201" }).fees.maxFeeStroops).toBe(201n);
    // A fixed bid replaces the floor: 2 × 100 < 201.
    expect(
      parseConfig({ ...minimal, MAX_FEE_STROOPS: "201", INCLUSION_FEE_STROOPS: "100" }).fees,
    ).toMatchObject({ maxFeeStroops: 201n, inclusionFeeStroops: 100n });
  });

  it("allows http catalog URLs on testnet only", () => {
    expect(parseConfig({ ...minimal, CATALOG_ALLOW_HTTP: "true" }).catalog.allowHttp).toBe(true);
    expect(
      problems({
        ...minimal,
        NETWORK: "stellar:pubnet",
        RPC_URLS: "https://rpc.example",
        CATALOG_ALLOW_HTTP: "true",
      }),
    ).toEqual(["CATALOG_ALLOW_HTTP is only allowed on testnet"]);
  });

  it("checks RPC URLs", () => {
    for (const url of ["ftp://rpc.example", "not a url", "https://user:pass@rpc.example"]) {
      expect(problems({ ...minimal, RPC_URLS: url })).toEqual([
        "RPC_URLS must be http(s) URLs without credentials",
      ]);
    }
    // Upstream's client allows http on testnet only.
    expect(parseConfig({ ...minimal, RPC_URLS: "http://rpc:8000" }).rpcUrls).toEqual([
      "http://rpc:8000",
    ]);
    expect(
      problems({
        ...minimal,
        NETWORK: "stellar:pubnet",
        RPC_URLS: "https://a.example,http://rpc:8000",
      }),
    ).toEqual(["RPC_URLS must be https outside testnet"]);
    expect(problems({ ...minimal, NETWORK: "stellar:pubnet", RPC_URLS: "," })).toEqual([
      "RPC_URLS must list at least one URL",
    ]);
    expect(problems({ ...minimal, NETWORK: "stellar:pubnet" })).toEqual([
      "RPC_URLS is required outside testnet",
    ]);
  });
});
