import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { SellerConfig } from "./app.js";

export type Config = Required<Pick<SellerConfig, "payTo">> &
  Pick<SellerConfig, "facilitatorUrl" | "apiKey"> & {
    port: number;
    /** The Stellar RPC that checks `payTo`'s trustline at start; testnet's public one when unset. */
    rpcUrl?: string;
  };

/** An unset variable and an empty one mean the same. */
const blankAsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((given) => (given === "" ? undefined : given), schema);

const ENV = z.object({
  SELLER_ADDRESS: z
    .string({ required_error: "is required: the Stellar testnet account that receives payments" })
    .refine(StrKey.isValidEd25519PublicKey, "must be a Stellar account address (G…)"),
  // Unset: the SDK's default, this project's facilitator.
  FACILITATOR_URL: blankAsUnset(z.string().url("must be a URL").optional()),
  X402_API_KEY: blankAsUnset(z.string().optional()),
  STELLAR_RPC_URL: blankAsUnset(z.string().url("must be a URL").optional()),
  PORT: blankAsUnset(
    z
      .string()
      .regex(/^\d+$/, "must be a port number")
      .transform(Number)
      // 0 lets the system pick a free port; the start line names the one it bound.
      .refine((port) => port <= 65_535, "must be between 0 and 65535")
      .default("4021"),
  ),
});

/** Reads the seller's settings from the environment; a wrong value stops the start. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = ENV.safeParse(env);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${issue!.path.join(".")} ${issue!.message}.`);
  }
  const { SELLER_ADDRESS, FACILITATOR_URL, X402_API_KEY, STELLAR_RPC_URL, PORT } = parsed.data;
  return {
    payTo: SELLER_ADDRESS,
    facilitatorUrl: FACILITATOR_URL,
    apiKey: X402_API_KEY,
    rpcUrl: STELLAR_RPC_URL,
    port: PORT,
  };
}
