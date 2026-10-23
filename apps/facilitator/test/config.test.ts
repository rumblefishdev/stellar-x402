import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  type Config,
  ConfigError,
  MAX_RPC_URLS,
  parseConfig,
  parseMigrateConfig,
} from "../src/config.js";

const keypair = (byte: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte));
const SECRET = keypair(1).secret();
const CHANNEL_A = keypair(2).publicKey();
const CHANNEL_B = keypair(3).publicKey();

const minimal = { FACILITATOR_SECRET: SECRET, CHANNELS: `${CHANNEL_A}, ${CHANNEL_B}` };
/** Pubnet needs the PostgreSQL store, and is refused until 0024, 0025 and 0050 land. */
const pubnet = {
  NETWORK: "stellar:pubnet",
  STORE: "postgres",
  DATABASE_URL: "postgres://db.internal/x402",
};
const PUBNET_REFUSED =
  "NETWORK stellar:pubnet is refused until spend budgets (0024), the channel lease (0025) and store pruning (0050) land";

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
        settleTimeoutMs: 20_000,
        settleBudgetMs: 30_000,
        leaseTtlMs: 30_000,
      },
      http: {
        bodyLimitBytes: 65_536,
        clientIpHeader: undefined,
        rateLimit: { windowMs: 60_000, verify: 600, settle: 600, discovery: 120 },
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
    // Distinct values, so two settings swapped in the mapping would fail. NETWORK can only be
    // testnet, its default, while pubnet is refused.
    const config = parseConfig({
      NETWORK: "stellar:testnet",
      PORT: "8080",
      LOG_LEVEL: "debug",
      RPC_URLS: "https://a.example, https://b.example",
      FACILITATOR_SECRET: SECRET,
      CHANNELS: CHANNEL_B,
      STORE: "postgres",
      DATABASE_URL: "postgres://db.internal/x402",
      MAX_FEE_STROOPS: "300001",
      INCLUSION_FEE_STROOPS: "201",
      FEE_ESCALATION_FACTOR: "1.5",
      FEE_ESCALATION_MAX_STROOPS: "1002",
      MIN_VALIDITY_LEDGERS: "13",
      SETTLE_TIMEOUT_MS: "31000",
      SETTLE_BUDGET_MS: "60000",
      LEASE_TTL_MS: "32000",
      BODY_LIMIT_BYTES: "70000",
      CLIENT_IP_HEADER: "CF-Connecting-IP",
      RATE_LIMIT_WINDOW_MS: "61000",
      RATE_LIMIT_VERIFY: "121",
      RATE_LIMIT_SETTLE: "122",
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
      network: "stellar:testnet",
      port: 8080,
      logLevel: "debug",
      rpcUrls: ["https://a.example", "https://b.example"],
      facilitatorSecret: SECRET,
      channels: [CHANNEL_B],
      store: "postgres",
      databaseUrl: "postgres://db.internal/x402",
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
        clientIpHeader: "cf-connecting-ip",
        rateLimit: { windowMs: 61_000, verify: 121, settle: 122, discovery: 123 },
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

  it("accepts PORT 0, which lets the system pick a free port", () => {
    expect(parseConfig({ ...minimal, PORT: "0" }).port).toBe(0);
  });

  it("keeps the settle budget below the seller's 90 s and the repeat wait within the budget", () => {
    expect(problems({ ...minimal, SETTLE_BUDGET_MS: "80001" })).toEqual([
      "SETTLE_BUDGET_MS must be between 1000 and 80000",
    ]);
    expect(problems({ ...minimal, SETTLE_BUDGET_MS: "10000", SETTLE_TIMEOUT_MS: "10001" })).toEqual(
      ["SETTLE_TIMEOUT_MS must be at most SETTLE_BUDGET_MS"],
    );
    expect(
      parseConfig({ ...minimal, SETTLE_BUDGET_MS: "80000", SETTLE_TIMEOUT_MS: "80000" }),
    ).toMatchObject({ settlement: { settleBudgetMs: 80_000, settleTimeoutMs: 80_000 } });
  });

  it("defaults the repeat wait to 20 s, or to a shorter budget, and needs at least 1 s", () => {
    expect(parseConfig(minimal).settlement).toMatchObject({
      settleBudgetMs: 30_000,
      settleTimeoutMs: 20_000,
    });
    // Only the budget set: the default wait follows it instead of failing startup.
    expect(parseConfig({ ...minimal, SETTLE_BUDGET_MS: "15000" }).settlement).toMatchObject({
      settleBudgetMs: 15_000,
      settleTimeoutMs: 15_000,
    });
    expect(problems({ ...minimal, SETTLE_TIMEOUT_MS: "999" })).toEqual([
      "SETTLE_TIMEOUT_MS must be between 1000 and 2147483647",
    ]);
  });

  it("accepts only plain decimal numbers in range", () => {
    expect(problems({ ...minimal, PORT: "0x10" })).toEqual(["PORT must be a whole number"]);
    expect(problems({ ...minimal, PORT: "70000" })).toEqual(["PORT must be between 0 and 65535"]);
    expect(problems({ ...minimal, SETTLE_TIMEOUT_MS: "1e20" })).toEqual([
      "SETTLE_TIMEOUT_MS must be a whole number",
    ]);
    expect(problems({ ...minimal, LEASE_TTL_MS: "99999999999" })).toEqual([
      "LEASE_TTL_MS must be between 1000 and 2147483647",
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

  it("keeps the /settle budget at or above /verify's: the seller calls both, settle after serving", () => {
    expect(problems({ ...minimal, RATE_LIMIT_VERIFY: "100", RATE_LIMIT_SETTLE: "99" })).toEqual([
      "RATE_LIMIT_SETTLE must be at least RATE_LIMIT_VERIFY",
    ]);
    expect(problems({ ...minimal, RATE_LIMIT_VERIFY: "700" })).toEqual([
      "RATE_LIMIT_SETTLE must be at least RATE_LIMIT_VERIFY",
    ]);
    expect(
      parseConfig({ ...minimal, RATE_LIMIT_VERIFY: "100", RATE_LIMIT_SETTLE: "100" }).http
        .rateLimit,
    ).toMatchObject({ verify: 100, settle: 100 });
  });

  it("takes CLIENT_IP_HEADER as a lower-case header name, and refuses a leftover TRUSTED_PROXY_HOPS", () => {
    expect(problems({ ...minimal, CLIENT_IP_HEADER: "cf connecting ip" })).toEqual([
      "CLIENT_IP_HEADER must be a header name",
    ]);
    // Left set, it would look like the client IP still came from X-Forwarded-For.
    expect(problems({ ...minimal, TRUSTED_PROXY_HOPS: "1" })).toEqual([
      "TRUSTED_PROXY_HOPS is replaced by CLIENT_IP_HEADER",
    ]);
  });

  it("ignores a leftover CATALOG_ALLOW_HTTP: every network catalogs http now (0053)", () => {
    expect(parseConfig({ ...minimal, CATALOG_ALLOW_HTTP: "true" })).toEqual(parseConfig(minimal));
    expect(
      problems({
        ...minimal,
        ...pubnet,
        RPC_URLS: "https://rpc.example",
        CATALOG_ALLOW_HTTP: "true",
      }),
    ).toEqual([PUBNET_REFUSED]);
  });

  it("selects the PostgreSQL store with its URL", () => {
    const url = "postgres://u:pw@db.internal:5432/x402";
    const config = parseConfig({ ...minimal, STORE: "postgres", DATABASE_URL: url });
    expect(config.store).toBe("postgres");
    expect(config.databaseUrl).toBe(url);
  });

  it("requires a postgres:// DATABASE_URL for STORE=postgres, without echoing it", () => {
    expect(problems({ ...minimal, STORE: "postgres" })).toEqual([
      "DATABASE_URL is required when STORE=postgres",
    ]);
    const found = problems({
      ...minimal,
      STORE: "postgres",
      DATABASE_URL: "mysql://u:secret@db/x",
    });
    expect(found).toEqual(["DATABASE_URL must be a postgres:// URL"]);
    expect(() =>
      parseConfig({ ...minimal, STORE: "postgres", DATABASE_URL: "mysql://u:secret@db/x" }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("secret") }));
  });

  it("allows the memory store on testnet only, and never with a DATABASE_URL", () => {
    expect(parseConfig(minimal).store).toBe("memory");
    const rpc = { RPC_URLS: "https://rpc.example" };
    expect(problems({ ...minimal, ...rpc, NETWORK: "stellar:pubnet" })).toEqual([
      "STORE must be postgres outside testnet",
      PUBNET_REFUSED,
    ]);
    expect(problems({ ...minimal, ...rpc, ...pubnet, STORE: "memory" })).toEqual([
      "STORE must be postgres outside testnet",
      PUBNET_REFUSED,
      "DATABASE_URL is only used with STORE=postgres",
    ]);
    expect(problems({ ...minimal, DATABASE_URL: "postgres://db.internal/x402" })).toEqual([
      "DATABASE_URL is only used with STORE=postgres",
    ]);
  });

  it("refuses stellar:pubnet with nothing else wrong, until 0024, 0025 and 0050 land", () => {
    // `/settle` would spend there with allow-all spend hooks, no rate limit and no lease.
    expect(problems({ ...minimal, ...pubnet, RPC_URLS: "https://rpc.example" })).toEqual([
      PUBNET_REFUSED,
    ]);
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
      problems({ ...minimal, ...pubnet, RPC_URLS: "https://a.example,http://rpc:8000" }),
    ).toEqual(["RPC_URLS must be https outside testnet", PUBNET_REFUSED]);
    expect(problems({ ...minimal, ...pubnet, RPC_URLS: "," })).toEqual([
      "RPC_URLS must list at least one URL",
      PUBNET_REFUSED,
    ]);
    expect(problems({ ...minimal, ...pubnet })).toEqual([
      "RPC_URLS is required outside testnet",
      PUBNET_REFUSED,
    ]);
  });
});

describe("parseMigrateConfig", () => {
  it("requires DATABASE_URL", () => {
    for (const env of [{}, { DATABASE_URL: " " }]) {
      const error = (() => {
        try {
          parseMigrateConfig(env);
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual(["DATABASE_URL is required"]);
    }
  });

  it("trims a postgres:// URL", () => {
    expect(parseMigrateConfig({ DATABASE_URL: " postgresql://db/x402\n" })).toEqual({
      databaseUrl: "postgresql://db/x402",
    });
  });

  it(`lists at most ${MAX_RPC_URLS} RPC URLs, as each adds 10 s to upstream verify's deadline`, () => {
    const urls = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://rpc-${i}.example`).join(",");
    expect(parseConfig({ ...minimal, RPC_URLS: urls(MAX_RPC_URLS) }).rpcUrls).toHaveLength(
      MAX_RPC_URLS,
    );
    expect(problems({ ...minimal, RPC_URLS: urls(MAX_RPC_URLS + 1) })).toEqual([
      `RPC_URLS must list at most ${MAX_RPC_URLS} URLs`,
    ]);
  });
});
