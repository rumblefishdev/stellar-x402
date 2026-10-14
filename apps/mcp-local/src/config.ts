import type { ServerConfig } from "@stellar-x402/mcp";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import { createEd25519Signer, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** What `createServer` needs, read from the environment; only the log is added by the caller. */
export type CliConfig = Omit<ServerConfig, "log">;

/** An unset variable and an empty one mean the same: not given. */
const blank = (value: unknown) => (value === "" ? undefined : value);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());
/** The default goes inside the preprocessing, so an empty value gets it too. */
const orDefault = <T extends z.ZodTypeAny>(schema: T, value: z.input<T>) =>
  z.preprocess(blank, schema.default(value));

/** Plain decimal digits only, like the amounts: no `1e3`, hex or spaces. */
const POSITIVE = z
  .string()
  .regex(/^\d+$/, "must be a positive integer")
  .transform(Number)
  .refine((value) => value > 0, "must be a positive integer");
/** An amount in the asset's smallest unit: 10000 is 0.001 USDC. */
const ATOMIC = z
  .string()
  .regex(/^\d+$/, "must be an amount in atomic units (10000 = 0.001 USDC)")
  .transform(BigInt);

const ENV = z.object({
  STELLAR_X402_DISCOVERY_URL: z
    .string({ required_error: "is required" })
    .min(1, "is required")
    .url("must be a URL, such as https://catalog.example.com"),
  STELLAR_X402_NETWORK: optional(
    z.literal(STELLAR_NETWORKS.testnet, {
      errorMap: () => ({
        message: "must be stellar:testnet; this server pays on stellar:testnet only",
      }),
    }),
  ),
  // The MCP client gives up on a request after 60 s (SDK default); a whole tool call, its unpaid
  // request and paid retry together, ends within this, so the agent gets its answer before that.
  STELLAR_X402_TIMEOUT_MS: orDefault(POSITIVE, "30000"),
  // A response body goes into the model's context: 100 kB is about 25k tokens.
  STELLAR_X402_MAX_RESPONSE_BYTES: orDefault(POSITIVE, "100000"),
  STELLAR_X402_ALLOW_INSECURE_LOCAL: optional(z.enum(["0", "1"], { message: "must be 0 or 1" })),
  STELLAR_X402_SECRET_KEY: optional(z.string()),
  STELLAR_X402_MAX_PER_CALL: optional(ATOMIC),
  STELLAR_X402_DAILY_BUDGET: optional(ATOMIC),
  STELLAR_X402_STATE_DIR: optional(z.string()),
});

/** Outside any project, so every Claude session of the user counts against the same day. */
const DEFAULT_STATE_DIR = join(homedir(), ".stellar-x402-mcp");

/**
 * Reads the server's settings from environment variables, as an MCP client such as Claude Desktop
 * passes them. Any missing, wrong or unknown `STELLAR_X402_` value stops the start with a message
 * naming the variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv): CliConfig {
  // A misspelt name would otherwise leave its setting at the default without a word.
  const unknown = Object.keys(env).find(
    (name) => name.startsWith("STELLAR_X402_") && !(name in ENV.shape),
  );
  if (unknown === "STELLAR_X402_BUDGET") {
    throw new Error(
      "STELLAR_X402_BUDGET is not a setting of this server; it was replaced by STELLAR_X402_DAILY_BUDGET.",
    );
  }
  if (unknown === "STELLAR_X402_STATE_FILE") {
    throw new Error(
      "STELLAR_X402_STATE_FILE is not a setting of this server; it was replaced by STELLAR_X402_STATE_DIR, a directory.",
    );
  }
  if (unknown) throw new Error(`${unknown} is not a setting of this server.`);
  const parsed = ENV.safeParse(env);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${issue!.path.join(".")} ${issue!.message}.`);
  }
  const vars = parsed.data;
  // The limits and the state directory only matter when paying; without a key they would do nothing.
  if (vars.STELLAR_X402_SECRET_KEY === undefined) {
    const paymentOnly = [
      "STELLAR_X402_MAX_PER_CALL",
      "STELLAR_X402_DAILY_BUDGET",
      "STELLAR_X402_STATE_DIR",
    ] as const;
    const set = paymentOnly.find((name) => vars[name] !== undefined);
    if (set) throw new Error(`${set} needs STELLAR_X402_SECRET_KEY.`);
  }
  const config: CliConfig = {
    discoveryUrl: vars.STELLAR_X402_DISCOVERY_URL,
    timeoutMs: vars.STELLAR_X402_TIMEOUT_MS,
    maxResponseBytes: vars.STELLAR_X402_MAX_RESPONSE_BYTES,
    allowInsecureLocal: vars.STELLAR_X402_ALLOW_INSECURE_LOCAL === "1",
  };
  if (vars.STELLAR_X402_SECRET_KEY === undefined) return config;
  // Spending needs both limits: the server never guesses how much it may pay.
  if (vars.STELLAR_X402_MAX_PER_CALL === undefined) {
    throw new Error("STELLAR_X402_MAX_PER_CALL is required.");
  }
  if (vars.STELLAR_X402_DAILY_BUDGET === undefined) {
    throw new Error("STELLAR_X402_DAILY_BUDGET is required.");
  }
  let signer;
  try {
    signer = createEd25519Signer(vars.STELLAR_X402_SECRET_KEY, STELLAR_NETWORKS.testnet);
  } catch {
    // The library's message could quote the key, so it is not passed on.
    throw new Error("STELLAR_X402_SECRET_KEY is not a Stellar secret key.");
  }
  return {
    ...config,
    payment: {
      schemes: [{ network: STELLAR_NETWORKS.testnet, client: new ExactStellarScheme(signer) }],
      payer: signer.address,
      assets: {
        [USDC_TESTNET_ADDRESS]: {
          maxPerCall: vars.STELLAR_X402_MAX_PER_CALL,
          daily: vars.STELLAR_X402_DAILY_BUDGET,
        },
      },
      dailyDir: vars.STELLAR_X402_STATE_DIR ?? DEFAULT_STATE_DIR,
    },
  };
}
