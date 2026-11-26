import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { SellerConfig } from "./app.js";

export type Config = SellerConfig & { port: number };

/**
 * Names a catalog never lists, as `packages/bazaar` refuses them (`canonicalizeUrl`,
 * `isForbiddenHost`): special-use and private suffixes. Kept here so the example has no
 * dependency on our packages; a seller named under one of them is never listed.
 */
const PRIVATE_SUFFIXES = [
  "localhost",
  "localdomain",
  "local",
  "internal",
  "home.arpa",
  "invalid",
  "test",
  "example",
  "alt",
  "onion",
  "home",
  "corp",
  "mail",
];

/**
 * Whether a catalog can list a resource at this origin: no user or password, and a public DNS
 * name — not an IP address, not a single label, no trailing dot, no private suffix.
 */
function isListableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // Another check names what is wrong with it.
    return true;
  }
  const host = url.hostname;
  return (
    url.username === "" &&
    url.password === "" &&
    !host.startsWith("[") &&
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) &&
    host.includes(".") &&
    !host.endsWith(".") &&
    !PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  );
}

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
      // 0 lets the system pick a free port; the start line names the one it bound.
      .refine((port) => port <= 65_535, "must be between 0 and 65535"),
    "4021",
  ),
  // Behind a proxy (the server's Cloudflare tunnel) the request arrives as plain http, so the
  // 402 would name an http:// resource, which a catalog refuses. This names the public one.
  PUBLIC_ORIGIN: z.preprocess(
    (given) => (given === "" ? undefined : given),
    z
      .string()
      .url("must be a URL")
      // Zod runs each check even after one failed, so none of these parses the value.
      .refine((url) => url.startsWith("https://"), "must be https")
      .refine(
        (url) => /^https:\/\/[^/?#]+\/?$/.test(url),
        "must be an origin only, such as https://seller.example.com",
      )
      .refine(
        isListableOrigin,
        "must name a public host, which a catalog can list: no user or password, no IP address, " +
          "no trailing dot, a DNS name outside the private suffixes",
      )
      .transform((url) => url.replace(/\/$/, ""))
      .optional(),
  ),
});

/** Reads the seller's settings from the environment; a wrong value stops the start. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = ENV.safeParse(env);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${issue!.path.join(".")} ${issue!.message}.`);
  }
  const { SELLER_ADDRESS, FACILITATOR_URL, PORT, PUBLIC_ORIGIN } = parsed.data;
  return {
    payTo: SELLER_ADDRESS,
    facilitatorUrl: FACILITATOR_URL,
    port: PORT,
    ...(PUBLIC_ORIGIN && { publicOrigin: PUBLIC_ORIGIN }),
  };
}
