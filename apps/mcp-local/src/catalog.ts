import { LIMITS } from "@stellar-x402/bazaar";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
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

/** The list_resources tool's input and output, as server.ts registers it. */
const LIST_RESOURCES_INPUT = z
  .object({
    type: z.enum(["http", "mcp"]).optional().describe("HTTP endpoints or MCP tools"),
    payTo: z.string().optional().describe("Address that receives the payment"),
    scheme: z
      .string()
      .optional()
      .describe("Payment scheme: exact charges the listed amount, upto charges usage up to it"),
    network: z
      .enum([STELLAR_NETWORKS.testnet, STELLAR_NETWORKS.pubnet])
      .optional()
      .describe("Network the payment is made on"),
    extensions: z.string().optional().describe("Extension key the resource must carry"),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Page size; the catalog sets the default and the maximum"),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Entries to skip; pagination.total says how many match"),
  })
  .strict();

const LIST_RESOURCES_OUTPUT = { items: z.array(SUMMARY), pagination: PAGINATION };

/** The search_resources tool's input: the list's filters without `offset`, a query and a cursor. */
const SEARCH_RESOURCES_INPUT = LIST_RESOURCES_INPUT.omit({ offset: true }).extend({
  query: z.string().describe("What you need, in your own words"),
  network: LIST_RESOURCES_INPUT.shape.network.describe(
    "Network the payment is made on; without it, both are searched",
  ),
  cursor: z
    .string()
    .optional()
    .describe("pagination.cursor of the previous page, as it came; absent for the first page"),
});

/** Upstream's search answer; the spec makes `partialResults` and `pagination` optional. */
const SEARCH_PAGE = z.object({
  resources: z.array(ENTRY),
  partialResults: z.boolean().optional(),
  pagination: z.object({ limit: z.number(), cursor: z.string().nullable() }).nullish(),
});

const SEARCH_RESOURCES_OUTPUT = {
  items: z.array(SUMMARY).describe("Best match first"),
  partialResults: z
    .boolean()
    .optional()
    .describe("true: some matches were left out, and no later page returns them"),
  pagination: SEARCH_PAGE.shape.pagination.describe(
    "cursor: pass it back for the next page; null when there is none",
  ),
};

/**
 * The parameter a catalog's `400` names, read from upstream's error: its client throws a plain
 * Error whose message is `… failed (<status>): <body>`, and our route's body is
 * `{"error":"bad_request","param":"<name>"}`. Anything else gives `undefined`.
 */
function refusedParam(error: unknown): string | undefined {
  const answer = /failed \(400\): (.*)$/s.exec(String(error));
  if (!answer) return undefined;
  try {
    const body: unknown = JSON.parse(answer[1]!);
    const param = (body as { param?: unknown }).param;
    return typeof param === "string" ? param : "";
  } catch {
    // A 400 without our route's body still names the agent's input as the cause.
    return "";
  }
}

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

export {
  LIST_RESOURCES_INPUT,
  LIST_RESOURCES_OUTPUT,
  PAGE,
  SEARCH_PAGE,
  SEARCH_RESOURCES_INPUT,
  SEARCH_RESOURCES_OUTPUT,
  deadline,
  refusedParam,
  summary,
};
