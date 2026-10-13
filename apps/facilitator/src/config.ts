import { StrKey } from "@stellar/stellar-sdk";
import { FEE_STATS_MIN_STROOPS } from "@stellar-x402/signer-pool";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import { z } from "zod";

/**
 * Facilitator configuration, read and validated once at startup from the environment (AD-12,
 * spine "Config" convention). Only `src/main.ts` reads `process.env`; everything else gets the
 * parsed {@link Config} through constructors.
 *
 * Numeric defaults are interim testnet values; mainnet fee values come from task 0010.
 */

const DEFAULT_TESTNET_RPC = "https://soroban-testnet.stellar.org";
/** Largest delay `setTimeout` accepts; longer ones fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

const list = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const oneOf = <const T extends [string, ...string[]]>(values: T) =>
  z.enum(values, { errorMap: () => ({ message: `must be one of ${values.join(", ")}` }) });

/** Plain decimal digits only: no hex, exponents, signs or `Infinity`. */
const int = (min: number, max: number = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .refine(
      (value) => value >= min && value <= max,
      max === Number.MAX_SAFE_INTEGER
        ? `must be at least ${min}`
        : `must be between ${min} and ${max}`,
    );
const ms = (min: number) => int(min, MAX_TIMER_MS);

const stroops = (min: bigint) =>
  z
    .string()
    .regex(/^\d+$/, "must be a whole number of stroops")
    .transform((value) => BigInt(value))
    .refine((value) => value >= min, `must be at least ${min}`);
/** The floor of `signer-pool`'s `feeStatsInclusionFee` bid, used when no bid is set. */
const FEE_STATS_MIN_BID_STROOPS = BigInt(FEE_STATS_MIN_STROOPS);

/** Fee settings reach upstream and the pool as a `number`. */
const feeStroops = stroops(100n).refine(
  (value) => value <= BigInt(Number.MAX_SAFE_INTEGER),
  `must be at most ${Number.MAX_SAFE_INTEGER}`,
);

/**
 * An http(s) URL without credentials. Upstream's RPC client refuses `user:pass@`, and it writes
 * the whole URL to stderr on a failed call.
 */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol, username, password } = new URL(value);
    return (protocol === "https:" || protocol === "http:") && !username && !password;
  } catch {
    return false;
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}

/** Holds a password, so it is never logged and no message echoes it. */
const databaseUrl = z.string().refine(isPostgresUrl, "must be a postgres:// URL");

const envSchema = z
  .object({
    NETWORK: oneOf([STELLAR_NETWORKS.testnet, STELLAR_NETWORKS.pubnet]).default(
      STELLAR_NETWORKS.testnet,
    ),
    PORT: int(1, 65_535).default("4021"),
    LOG_LEVEL: oneOf(["debug", "info", "warn", "error"]).default("info"),
    /**
     * Comma-separated; the first is primary, the rest are fallbacks for the pool and the ledger
     * reads. Upstream verify uses only the first, so `/verify` fails while it is down.
     */
    RPC_URLS: list
      .pipe(
        z
          .array(z.string().refine(isHttpUrl, "must be http(s) URLs without credentials"))
          .min(1, "must list at least one URL"),
      )
      .optional(),

    /** The facilitator key: signs for the channels and pays fee bumps. Never logged. */
    FACILITATOR_SECRET: z
      .string()
      .refine(
        (value) => StrKey.isValidEd25519SecretSeed(value),
        "must be a Stellar secret key (S…)",
      ),
    /** Comma-separated channel account addresses (never secrets). */
    CHANNELS: list.pipe(
      z
        .array(
          z
            .string()
            .refine(
              (value) => StrKey.isValidEd25519PublicKey(value),
              "must be Stellar account addresses (G…)",
            ),
        )
        .min(1, "must list at least one channel")
        .refine(
          (channels) => new Set(channels).size === channels.length,
          "must not repeat a channel",
        ),
    ),

    /**
     * Which store adapters the composition root builds; `postgres` needs `DATABASE_URL`. Memory
     * loses settlements on restart, so it is testnet only.
     */
    STORE: oneOf(["memory", "postgres"]).default("memory"),
    DATABASE_URL: databaseUrl.optional(),

    /** Fee ceiling for upstream verify and the pool alike (AD-10). */
    MAX_FEE_STROOPS: feeStroops.default("250000"),
    /**
     * Inclusion bid; unset means the pool's fee-stats provider (at least 100). A settlement pays
     * it twice, so twice the bid must stay below `MAX_FEE_STROOPS`.
     */
    INCLUSION_FEE_STROOPS: feeStroops.optional(),
    FEE_ESCALATION_FACTOR: z
      .string()
      .regex(/^\d+(\.\d+)?$/, "must be a decimal number")
      .transform(Number)
      // The pool refuses a factor of 1 or less at construction.
      .refine((value) => value > 1 && value <= 100, "must be above 1 and at most 100")
      .optional(),
    FEE_ESCALATION_MAX_STROOPS: int(100).optional(),

    /**
     * Least ledgers left before the payer's auth expires (AD-22): 2 for the pool plus about 2 of
     * channel wait. A client signs for only `maxTimeoutSeconds` (12 ledgers at 60 s). Below 2 the
     * pool refuses at `/settle` what `/verify` accepted (its one spare ledger).
     */
    MIN_VALIDITY_LEDGERS: int(2).default("4"),
    /** How long a repeat `/settle` waits on a pending record (AD-6). */
    SETTLE_TIMEOUT_MS: ms(1).default("30000"),
    /**
     * Longest `/settle` call, the wait for a channel included; below the load balancer's 120 s
     * idle timeout (ADR 0011).
     */
    SETTLE_BUDGET_MS: ms(1_000).default("90000"),
    /** Channel lease TTL; renewed well before it runs out (AD-17). */
    LEASE_TTL_MS: ms(1_000).default("30000"),

    BODY_LIMIT_BYTES: int(1_024).default("65536"),
    /** Proxy hops in front of the service whose `X-Forwarded-For` entries are trusted (AD-11). */
    TRUSTED_PROXY_HOPS: int(0, 10).default("0"),
    RATE_LIMIT_WINDOW_MS: ms(1_000).default("60000"),
    RATE_LIMIT_VERIFY: int(1).default("120"),
    RATE_LIMIT_SETTLE: int(1).default("60"),
    RATE_LIMIT_DISCOVERY: int(1).default("120"),

    /** Rolling window of every spend budget (AD-18); a store window, not a timer. */
    SPEND_WINDOW_MS: int(60_000).default("86400000"),
    SPEND_GLOBAL_STROOPS: stroops(1n).default("5000000000"),
    SPEND_PER_PAYER_STROOPS: stroops(1n).default("50000000"),
    SPEND_PER_PAY_TO_STROOPS: stroops(1n).default("500000000"),
    SPEND_PER_ASSET_STROOPS: stroops(1n).default("2000000000"),
    /** Consecutive on-chain failures that open an asset or `payTo` breaker. */
    BREAKER_FAILURES: int(1).default("5"),
    BREAKER_COOLDOWN_MS: int(1_000).default("600000"),

    /** Development only: also catalog `http:` resource URLs (testnet). */
    CATALOG_ALLOW_HTTP: oneOf(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .refine((env) => env.RPC_URLS !== undefined || env.NETWORK === STELLAR_NETWORKS.testnet, {
    message: "is required outside testnet",
    path: ["RPC_URLS"],
  })
  // Upstream's RPC client refuses http outside testnet, which would make every `/verify` a 500.
  .refine(
    (env) =>
      env.NETWORK === STELLAR_NETWORKS.testnet ||
      (env.RPC_URLS ?? []).every((url) => url.startsWith("https:")),
    { message: "must be https outside testnet", path: ["RPC_URLS"] },
  )
  // Under the fee bump the bid is paid twice (AD-10), and the ceiling also pays the resource fee,
  // which is never 0: twice the bid at the ceiling fails every payment.
  .refine(
    (env) =>
      env.INCLUSION_FEE_STROOPS === undefined ||
      2n * env.INCLUSION_FEE_STROOPS < env.MAX_FEE_STROOPS,
    { message: "must be below half of MAX_FEE_STROOPS", path: ["INCLUSION_FEE_STROOPS"] },
  )
  // The same for the fee-stats bid, which is never below its floor.
  .refine(
    (env) =>
      env.INCLUSION_FEE_STROOPS !== undefined ||
      2n * FEE_STATS_MIN_BID_STROOPS < env.MAX_FEE_STROOPS,
    {
      message: `must be above ${2n * FEE_STATS_MIN_BID_STROOPS}, twice the fee-stats bid's floor`,
      path: ["MAX_FEE_STROOPS"],
    },
  )
  .refine((env) => !env.CATALOG_ALLOW_HTTP || env.NETWORK === STELLAR_NETWORKS.testnet, {
    message: "is only allowed on testnet",
    path: ["CATALOG_ALLOW_HTTP"],
  })
  .refine((env) => env.STORE !== "memory" || env.NETWORK === STELLAR_NETWORKS.testnet, {
    message: "must be postgres outside testnet",
    path: ["STORE"],
  })
  .refine((env) => env.DATABASE_URL !== undefined || env.STORE !== "postgres", {
    message: "is required when STORE=postgres",
    path: ["DATABASE_URL"],
  })
  // A URL with the memory store would look durable and isn't.
  .refine((env) => env.DATABASE_URL === undefined || env.STORE === "postgres", {
    message: "is only used with STORE=postgres",
    path: ["DATABASE_URL"],
  });

/** `pnpm migrate` needs only the database. */
const migrateEnvSchema = z.object({ DATABASE_URL: databaseUrl });

export type Env = z.input<typeof envSchema>;

/** Parsed environment, grouped for the parts that consume it. */
export interface Config {
  network: (typeof STELLAR_NETWORKS)[keyof typeof STELLAR_NETWORKS];
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  rpcUrls: string[];
  facilitatorSecret: string;
  channels: string[];
  store: "memory" | "postgres";
  /** Set when `store` is `postgres`. Never logged. */
  databaseUrl?: string;
  fees: {
    maxFeeStroops: bigint;
    inclusionFeeStroops?: bigint;
    escalation?: { factor?: number; max?: number };
  };
  settlement: {
    minValidityLedgers: number;
    settleTimeoutMs: number;
    settleBudgetMs: number;
    leaseTtlMs: number;
  };
  http: {
    bodyLimitBytes: number;
    trustedProxyHops: number;
    rateLimit: { windowMs: number; verify: number; settle: number; discovery: number };
  };
  spend: {
    windowMs: number;
    globalStroops: bigint;
    perPayerStroops: bigint;
    perPayToStroops: bigint;
    perAssetStroops: bigint;
    breakerFailures: number;
    breakerCooldownMs: number;
  };
  catalog: { allowHttp: boolean };
}

/** Names every invalid setting; never echoes a value, so a secret can't leak into logs. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(readonly problems: string[]) {
    super(`invalid configuration: ${problems.join("; ")}`);
  }
}

/** Parses `env` with `schema`, or throws a {@link ConfigError} naming each bad setting. */
function parseEnv<S extends z.ZodTypeAny>(
  schema: S,
  env: Record<string, string | undefined>,
): z.output<S> {
  // Values are trimmed (a secret read from a file keeps its newline); blank means "unset", as in
  // the deploy env examples.
  const present = Object.fromEntries(
    Object.entries(env)
      .map(([name, value]) => [name, value?.trim()] as const)
      .filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = schema.safeParse(present);
  if (!result.success) {
    // Every message is ours, so none can echo a value.
    const problems = result.error.issues.map((issue) => {
      const name = String(issue.path[0] ?? "environment");
      if (issue.code === "invalid_type") {
        return `${name} ${issue.received === "undefined" ? "is required" : "is invalid"}`;
      }
      return `${name} ${issue.message}`;
    });
    throw new ConfigError([...new Set(problems)]);
  }
  return result.data;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const e = parseEnv(envSchema, env);
  const escalation =
    e.FEE_ESCALATION_FACTOR !== undefined || e.FEE_ESCALATION_MAX_STROOPS !== undefined
      ? { factor: e.FEE_ESCALATION_FACTOR, max: e.FEE_ESCALATION_MAX_STROOPS }
      : undefined;
  return {
    network: e.NETWORK,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    rpcUrls: e.RPC_URLS ?? [DEFAULT_TESTNET_RPC],
    facilitatorSecret: e.FACILITATOR_SECRET,
    channels: e.CHANNELS,
    store: e.STORE,
    databaseUrl: e.DATABASE_URL,
    fees: {
      maxFeeStroops: e.MAX_FEE_STROOPS,
      inclusionFeeStroops: e.INCLUSION_FEE_STROOPS,
      escalation,
    },
    settlement: {
      minValidityLedgers: e.MIN_VALIDITY_LEDGERS,
      settleTimeoutMs: e.SETTLE_TIMEOUT_MS,
      settleBudgetMs: e.SETTLE_BUDGET_MS,
      leaseTtlMs: e.LEASE_TTL_MS,
    },
    http: {
      bodyLimitBytes: e.BODY_LIMIT_BYTES,
      trustedProxyHops: e.TRUSTED_PROXY_HOPS,
      rateLimit: {
        windowMs: e.RATE_LIMIT_WINDOW_MS,
        verify: e.RATE_LIMIT_VERIFY,
        settle: e.RATE_LIMIT_SETTLE,
        discovery: e.RATE_LIMIT_DISCOVERY,
      },
    },
    spend: {
      windowMs: e.SPEND_WINDOW_MS,
      globalStroops: e.SPEND_GLOBAL_STROOPS,
      perPayerStroops: e.SPEND_PER_PAYER_STROOPS,
      perPayToStroops: e.SPEND_PER_PAY_TO_STROOPS,
      perAssetStroops: e.SPEND_PER_ASSET_STROOPS,
      breakerFailures: e.BREAKER_FAILURES,
      breakerCooldownMs: e.BREAKER_COOLDOWN_MS,
    },
    catalog: { allowHttp: e.CATALOG_ALLOW_HTTP },
  };
}

/** The config of `pnpm migrate`: only `DATABASE_URL`, which it requires. */
export function parseMigrateConfig(env: Record<string, string | undefined>): {
  databaseUrl: string;
} {
  return { databaseUrl: parseEnv(migrateEnvSchema, env).DATABASE_URL };
}
