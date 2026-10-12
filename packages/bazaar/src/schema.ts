import { LIMITS } from "./limits.js";

interface Frame {
  value: unknown;
  depth: number;
  /** JSON-pointer segments from the schema root. */
  path: string[];
  /** Whether this object's keys are schema keywords, or names in a map such as `properties`. */
  keywords: boolean;
}

/** Keywords whose value maps names to subschemas: the names are data, not keywords. */
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
/** Keywords whose value is instance data, never walked for keywords. */
const DATA_KEYWORDS = new Set(["examples", "example", "default", "const", "enum"]);

function decodePointer(ref: string): string[] | undefined {
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return undefined;
  try {
    // RFC 6901 §6: the fragment is percent-decoded first, then `~1` and `~0` are unescaped.
    return ref
      .slice(2)
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~"));
  } catch {
    return undefined;
  }
}

function isPrefix(prefix: string[], path: string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i]);
}

/**
 * Whether a seller-supplied JSON Schema fits our caps. The schema is treated as data: it is
 * walked with an explicit stack (so a deeply nested payload can't overflow ours) and never
 * compiled. Fails on depth over 10, more than 1,000 nodes, a `$ref`/`$id` that isn't a local
 * pointer, a `$ref` that points at one of its own ancestors, or a `pattern` over 256 characters.
 * Keyword rules apply to keywords only: not to property names, nor inside `enum`, `default` etc.
 */
export function isSchemaWithinLimits(schema: unknown): boolean {
  const stack: Frame[] = [{ value: schema, depth: 0, path: [], keywords: true }];
  let nodes = 1;
  while (stack.length > 0) {
    const { value, depth, path, keywords } = stack.pop()!;
    if (depth > LIMITS.schemaDepth) return false;
    if (value === null || typeof value !== "object") continue;
    const isArray = Array.isArray(value);
    const entries: [string, unknown][] = isArray
      ? value.map((item, i) => [String(i), item])
      : Object.entries(value);
    for (const [key, child] of entries) {
      const keyword = keywords && !isArray;
      if (keyword) {
        if (DATA_KEYWORDS.has(key)) continue;
        if (key === "$id" && !(typeof child === "string" && child.startsWith("#"))) return false;
        if (key === "$ref") {
          const target = typeof child === "string" ? decodePointer(child) : undefined;
          if (!target || isPrefix(target, path)) return false;
        }
        if (
          key === "pattern" &&
          typeof child === "string" &&
          child.length > LIMITS.schemaPatternChars
        )
          return false;
      }
      if (++nodes > LIMITS.schemaNodes) return false;
      const childKeywords = !(keyword && SCHEMA_MAPS.has(key));
      stack.push({ value: child, depth: depth + 1, path: [...path, key], keywords: childKeywords });
    }
  }
  return true;
}
