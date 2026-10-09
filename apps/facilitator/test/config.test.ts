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
      settlement: { minValidityLedgers: 12, settleTimeoutMs: 30_000, leaseTtlMs: 30_000 },
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
    });
  });

  it("maps every setting to its own field", () => {
    // Distinct values, so two settings swapped in the mapping would fail.
    const config = parseConfig({
      NETWORK: "stellar:pubnet",
      PORT: "8080",
      LOG_LEVEL: "debug",
      RPC_URLS: "https://a.example, http://b.example",
      FACILITATOR_SECRET: SECRET,
      CHANNELS: CHANNEL_B,
      STORE: "memory",
      MAX_FEE_STROOPS: "300001",
      INCLUSION_FEE_STROOPS: "201",
      FEE_ESCALATION_FACTOR: "1.5",
      FEE_ESCALATION_MAX_STROOPS: "1002",
      MIN_VALIDITY_LEDGERS: "13",
      SETTLE_TIMEOUT_MS: "31000",
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
      rpcUrls: ["https://a.example", "http://b.example"],
      facilitatorSecret: SECRET,
      channels: [CHANNEL_B],
      store: "memory",
      fees: {
        maxFeeStroops: 300_001n,
        inclusionFeeStroops: 201n,
        escalation: { factor: 1.5, max: 1002 },
      },
      settlement: { minValidityLedgers: 13, settleTimeoutMs: 31_000, leaseTtlMs: 32_000 },
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
  });

  it("checks RPC URLs", () => {
    expect(problems({ ...minimal, RPC_URLS: "ftp://rpc.example" })).toEqual([
      "RPC_URLS must be http(s) URLs",
    ]);
    expect(problems({ ...minimal, RPC_URLS: "not a url, also not" })).toEqual([
      "RPC_URLS must be http(s) URLs",
    ]);
    expect(problems({ ...minimal, NETWORK: "stellar:pubnet", RPC_URLS: "," })).toEqual([
      "RPC_URLS must list at least one URL",
    ]);
    expect(problems({ ...minimal, NETWORK: "stellar:pubnet" })).toEqual([
      "RPC_URLS is required outside testnet",
    ]);
  });
});
