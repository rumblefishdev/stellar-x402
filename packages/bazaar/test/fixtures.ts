import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

export const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  amount: "10000",
  payTo: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
  maxTimeoutSeconds: 60,
  extra: {},
};

export interface PayloadOptions {
  url?: unknown;
  resource?: Record<string, unknown>;
  bazaar?: unknown;
  info?: unknown;
  schema?: unknown;
  routeTemplate?: unknown;
  x402Version?: unknown;
  otherExtensions?: Record<string, unknown>;
}

export const httpInfo = { input: { type: "http", method: "GET" } };
export const mcpInfo = {
  input: { type: "mcp", toolName: "get_weather", inputSchema: { type: "object" } },
};

/** A v2 payload with an `extensions.bazaar` block; every part can be overridden. */
export function payload(options: PayloadOptions = {}): PaymentPayload {
  const bazaar =
    "bazaar" in options
      ? options.bazaar
      : {
          info: "info" in options ? options.info : httpInfo,
          schema: "schema" in options ? options.schema : { type: "object" },
          ...("routeTemplate" in options ? { routeTemplate: options.routeTemplate } : {}),
        };
  return {
    x402Version: ("x402Version" in options ? options.x402Version : 2) as number,
    resource: {
      url: ("url" in options ? options.url : "https://api.example.com/users/42") as string,
      description: "User profile",
      mimeType: "application/json",
      ...options.resource,
    },
    accepted: requirements,
    payload: {},
    extensions: { ...options.otherExtensions, bazaar },
  } as PaymentPayload;
}

/** Nested arrays `depth` levels deep. */
export function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}
