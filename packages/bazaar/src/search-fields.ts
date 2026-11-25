import type { DiscoveryResource } from "@x402/extensions/bazaar";

/** The four fields search ranks a listing by, weighted name, tags, description, parameters. */
export interface SearchFields {
  name: string;
  tags: string;
  description: string;
  parameters: string;
}

/** ADR 0014: at most 40 parameter entries, a name or a description each, cut at 300 characters. */
const MAX_PARAMETER_ENTRIES = 40;
const MAX_PARAMETER_CHARS = 300;

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
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
 * - parameters: each input's name once, in name order, with its description, from the HTTP query
 *   and body fields or the MCP tool's arguments. An HTTP listing's `info` holds example values (`validate.ts`), so
 *   only its names are read there; descriptions come from the schemas.
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
  const add = (name: string, description: string | undefined) =>
    inputs.set(name, inputs.get(name) ?? description);
  for (const examples of [input["queryParams"], input["body"]])
    for (const name of Object.keys(record(examples))) add(name, undefined);
  for (const schema of [
    record(input["inputSchema"])["properties"],
    record(schemaInput["queryParams"])["properties"],
    record(schemaInput["body"])["properties"],
  ])
    for (const [name, value] of Object.entries(record(schema)))
      add(name, text(record(value)["description"]));
  // The stored listing (PostgreSQL's jsonb) keeps no key order, so the inputs go in name order: a
  // listing gives the same fields before it is stored and after.
  const entries = [...inputs.keys()]
    .sort()
    .flatMap((name) => [name, inputs.get(name)])
    .filter((entry) => entry !== undefined);

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
    parameters: entries
      .slice(0, MAX_PARAMETER_ENTRIES)
      .map((entry) => Array.from(entry).slice(0, MAX_PARAMETER_CHARS).join(""))
      .join(" "),
  };
}
