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
    .describe(
      "pagination.cursor of the previous page, as it came, with the same query and filters; " +
        "absent for the first page and after any change to them",
    ),
});

/** A search page's place: the spec makes it optional. */
const SEARCH_PAGINATION = z.object({ limit: z.number(), cursor: z.string().nullable() }).nullish();

const SEARCH_RESOURCES_OUTPUT = {
  items: z.array(SUMMARY).describe("Best match first"),
  partialResults: z
    .boolean()
    .optional()
    .describe("true: some matches were left out, and no later page returns them"),
  pagination: SEARCH_PAGINATION.describe(
    "cursor: pass it back for the next page; null when there is none",
  ),
};

export {
  LIST_RESOURCES_INPUT,
  LIST_RESOURCES_OUTPUT,
  SEARCH_RESOURCES_INPUT,
  SEARCH_RESOURCES_OUTPUT,
};
