import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { SellerConfig } from "./app.js";

export type Config = SellerConfig & { port: number };

/** An unset variable and an empty one mean the same: the default applies. */
const orDefault = <T extends z.ZodTypeAny>(schema: T, value: string) =>
  z.preprocess((given) => (given === "" ? undefined : given), schema.default(value));

const ENV = z.object({
  SELLER_ADDRESS: z
    .string({ required_error: "is required: the Stellar testnet account that receives payments" })
    .refine(StrKey.isValidEd25519PublicKey, "must be a Stellar account address (G…)"),
  FACILITATOR_URL: orDefault(z.string().url("must be a URL"), "https://www.x402.org/facilitator"),
  PORT: orDefault(
    z
      .string()
      .regex(/^\d+$/, "must be a port number")
      .transform(Number)
      .refine((port) => port >= 1 && port <= 65_535, "must be between 1 and 65535"),
    "4021",
  ),
});

/** Reads the seller's settings from the environment; a wrong value stops the start. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = ENV.safeParse(env);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${issue!.path.join(".")} ${issue!.message}.`);
  }
  const { SELLER_ADDRESS, FACILITATOR_URL, PORT } = parsed.data;
  return { payTo: SELLER_ADDRESS, facilitatorUrl: FACILITATOR_URL, port: PORT };
}
