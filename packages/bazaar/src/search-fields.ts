import type { DiscoveryResource } from "@x402/extensions/bazaar";

/**
 * The version of the rules below. Search keeps it on each listing's card, so a change to the rules
 * is a bump here: the facilitator rewrites every card built by an older version.
 */
export const SEARCH_FIELDS_VERSION = 1;

/** The four fields search ranks a listing by, weighted name, tags, description, parameters. */
export interface SearchFields {
  name: string;
  tags: string;
  description: string;
  parameters: string;
}

/** ADR 0014: at most 40 parameter words, each cut at 300 characters. */
const MAX_PARAMETER_WORDS = 40;
const MAX_PARAMETER_CHARS = 300;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Json => (isRecord(value) ? value : {});
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const join = (parts: (string | undefined)[]) => parts.filter((part) => part).join(" ");

/** The words of the URL's path: `https://a.example/v1/forecast?city=x` gives `v1 forecast`. */
function pathWords(url: string): string {
  const path = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/.exec(url)?.[1] ?? "";
  return path.replace(/[^A-Za-z0-9]+/g, " ").trim();
}

/**
 * A listing's search fields, from what the seller's 402 says (ADR 0014), the shape upstream's
 * Bazaar types give it:
 * - name: the service name, an MCP tool's name and the words of the URL's path;
 * - tags;
 * - description: the listing's, the MCP tool's own and its input schema's;
 * - parameters: each input's name once, with its description, from the HTTP query and body fields
 *   or the MCP tool's arguments, then the extension schema's.
 * A field of an unexpected shape adds nothing.
 */
export function searchFields(listing: DiscoveryResource): SearchFields {
  const bazaar = record(record(listing.extensions)["bazaar"]);
  const input = record(record(bazaar["info"])["input"]);
  const schemaInput = record(
    record(record(record(bazaar["schema"])["properties"])["input"])["properties"],
  );
  const toolName = text(input["toolName"]);

  const tags = Array.isArray(listing.tags)
    ? listing.tags.filter((tag): tag is string => typeof tag === "string" && tag !== "")
    : [];

  // An HTTP listing names its inputs twice, in `info` and in the schema: each counts once.
  const inputs = new Map<string, string | undefined>();
  for (const fields of [
    input["queryParams"],
    input["body"],
    record(input["inputSchema"])["properties"],
    record(schemaInput["queryParams"])["properties"],
    record(schemaInput["body"])["properties"],
  ])
    for (const [name, value] of Object.entries(record(fields)))
      inputs.set(name, inputs.get(name) ?? text(record(value)["description"]));
  const words = [...inputs].flatMap(([name, description]) =>
    description === undefined ? [name] : [name, description],
  );

  return {
    name: join([
      text(listing.serviceName),
      toolName?.replaceAll("_", " "),
      typeof listing.resource === "string" ? pathWords(listing.resource) : undefined,
    ]),
    tags: tags.join(" "),
    description: join([
      text(listing.description),
      text(input["description"]),
      text(record(input["inputSchema"])["description"]),
    ]),
    parameters: words
      .slice(0, MAX_PARAMETER_WORDS)
      .map((word) => Array.from(word).slice(0, MAX_PARAMETER_CHARS).join(""))
      .join(" "),
  };
}
