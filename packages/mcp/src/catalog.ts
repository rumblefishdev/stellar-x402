import { LIMITS } from "@stellar-x402/bazaar";
import { z } from "zod";

const ACCEPT = z.object({
  scheme: z.string(),
  network: z.string(),
  amount: z.string().describe("Price in the asset's smallest unit: 10000 is 0.001 USDC"),
  asset: z.string(),
  payTo: z.string(),
});

const PAGINATION = z.object({ limit: z.number(), offset: z.number(), total: z.number() });

const SUMMARY = z.object({
  resource: z.string(),
  type: z.string(),
  description: z.string().optional(),
  serviceName: z.string().optional(),
  accepts: z.array(ACCEPT),
  input: z
    .record(z.unknown())
    .optional()
    .describe("How to call it: HTTP method and parameters, or MCP tool name and input schema"),
});

const ENTRY = z.object({
  resource: z.string(),
  type: z.string(),
  accepts: z.array(ACCEPT),
  description: z.string().optional(),
  serviceName: z.string().optional(),
  extensions: z.record(z.unknown()).optional(),
});

/** Read the catalog's answer, never trust its shape: a malformed page becomes an upstream_error. */
const PAGE = z.object({ items: z.array(ENTRY), pagination: PAGINATION });

type Entry = z.infer<typeof ENTRY>;

/** The upstream `listResources` takes no abort signal, so a catalog that never answers is cut off here. */
function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * The catalog is written by sellers: keep their free text short before it reaches the model. The
 * input description is passed as the catalog holds it; our catalog bounds its size and depth on intake.
 */
function summary(item: Entry) {
  const bazaar = item.extensions?.bazaar as
    { info?: { input?: Record<string, unknown> } } | undefined;
  return {
    resource: item.resource,
    type: item.type,
    description: item.description?.slice(0, LIMITS.descriptionChars),
    serviceName: item.serviceName?.slice(0, LIMITS.descriptionChars),
    // Parsing with ACCEPT already dropped the payment terms the agent does not choose by.
    accepts: item.accepts,
    input: bazaar?.info?.input,
  };
}

export { PAGE, PAGINATION, SUMMARY, deadline, summary };
