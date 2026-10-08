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

const SECRET_KEY = /^S[A-Z2-7]{55}$/;
const ACCOUNT_ADDRESS = /^G[A-Z2-7]{55}$/;

const list = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const int = (min: number) => z.coerce.number().int().min(min);
const stroops = (min: bigint) =>
  z
    .string()
    .regex(/^\d+$/, "must be a whole number of stroops")
    .transform((value) => BigInt(value))
    .refine((value) => value >= min, `must be at least ${min}`);

const envSchema = z
  .object({
    NETWORK: z.enum([STELLAR_NETWORKS.testnet, STELLAR_NETWORKS.pubnet]).default("stellar:testnet"),
    PORT: int(1).max(65_535).default(4021),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    /** Comma-separated; the first is primary, the rest are fallbacks. */
    RPC_URLS: list.pipe(z.array(z.string().url())).optional(),

    /** The facilitator key: signs for the channels and pays fee bumps. Never logged. */
    FACILITATOR_SECRET: z.string().regex(SECRET_KEY, "must be a Stellar secret key (S…)"),
    /** Comma-separated channel account addresses (never secrets). */
    CHANNELS: list.pipe(
      z
        .array(z.string().regex(ACCOUNT_ADDRESS, "must be Stellar account addresses (G…)"))
        .min(1, "must list at least one channel"),
    ),

    /** Which store adapters the composition root builds (0013 adds the durable one). */
    STORE: z.enum(["memory"]).default("memory"),

    /** Fee ceiling for upstream verify and the pool alike (AD-10). */
    MAX_FEE_STROOPS: stroops(100n).default("250000"),
    /** Inclusion bid; unset means the pool's fee-stats provider (at least 100). */
    INCLUSION_FEE_STROOPS: stroops(100n).optional(),
    FEE_ESCALATION_FACTOR: z.coerce.number().min(1).optional(),
    FEE_ESCALATION_MAX_STROOPS: int(100).optional(),

    /** Least ledgers left before the payer's auth expires (AD-22). */
    MIN_VALIDITY_LEDGERS: int(1).default(12),
    /** How long a repeat `/settle` waits on a pending record (AD-6). */
    SETTLE_TIMEOUT_MS: int(1).default(30_000),
    /** Channel lease TTL; renewed well before it runs out (AD-17). */
    LEASE_TTL_MS: int(1_000).default(30_000),

    BODY_LIMIT_BYTES: int(1_024).default(65_536),
    /** Proxy hops in front of the service whose `X-Forwarded-For` entries are trusted (AD-11). */
    TRUSTED_PROXY_HOPS: int(0).default(0),
    RATE_LIMIT_WINDOW_MS: int(1_000).default(60_000),
    RATE_LIMIT_VERIFY: int(1).default(120),
    RATE_LIMIT_SETTLE: int(1).default(60),
    RATE_LIMIT_DISCOVERY: int(1).default(120),

    /** Rolling window of every spend budget (AD-18). */
    SPEND_WINDOW_MS: int(60_000).default(86_400_000),
    SPEND_GLOBAL_STROOPS: stroops(1n).default("5000000000"),
    SPEND_PER_PAYER_STROOPS: stroops(1n).default("50000000"),
    SPEND_PER_PAY_TO_STROOPS: stroops(1n).default("500000000"),
    SPEND_PER_ASSET_STROOPS: stroops(1n).default("2000000000"),
    /** Consecutive on-chain failures that open an asset or `payTo` breaker. */
    BREAKER_FAILURES: int(1).default(5),
    BREAKER_COOLDOWN_MS: int(1_000).default(600_000),
  })
  .refine((env) => env.RPC_URLS !== undefined || env.NETWORK === STELLAR_NETWORKS.testnet, {
    message: "is required outside testnet",
    path: ["RPC_URLS"],
  });

export type Env = z.input<typeof envSchema>;

/** Parsed environment, grouped for the parts that consume it. */
export interface Config {
  network: (typeof STELLAR_NETWORKS)[keyof typeof STELLAR_NETWORKS];
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  rpcUrls: string[];
  facilitatorSecret: string;
  channels: string[];
  store: "memory";
  fees: {
    maxFeeStroops: bigint;
    inclusionFeeStroops?: bigint;
    escalation?: { factor?: number; max?: number };
  };
  settlement: {
    minValidityLedgers: number;
    settleTimeoutMs: number;
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
}

/** Names every invalid setting; never echoes a value, so a secret can't leak into logs. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(readonly problems: string[]) {
    super(`invalid configuration: ${problems.join("; ")}`);
  }
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  // Blank values mean "unset", as in the deploy env examples.
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const name = String(issue.path[0] ?? "environment");
        return issue.code === "invalid_type" && issue.received === "undefined"
          ? `${name} is required`
          : `${name} ${issue.code === "custom" || issue.code === "invalid_string" ? issue.message : "is invalid"}`;
      }),
    );
  }
  const e = result.data;
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
    fees: {
      maxFeeStroops: e.MAX_FEE_STROOPS,
      inclusionFeeStroops: e.INCLUSION_FEE_STROOPS,
      escalation,
    },
    settlement: {
      minValidityLedgers: e.MIN_VALIDITY_LEDGERS,
      settleTimeoutMs: e.SETTLE_TIMEOUT_MS,
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
  };
}
