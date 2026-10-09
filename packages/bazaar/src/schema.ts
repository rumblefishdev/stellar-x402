import { LIMITS } from "./limits.js";

interface Frame {
  value: unknown;
  depth: number;
  /** JSON-pointer segments from the schema root. */
  path: string[];
}

function decodePointer(ref: string): string[] | undefined {
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isPrefix(prefix: string[], path: string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i]);
}

/**
 * Whether a seller-supplied JSON Schema fits our caps. The schema is treated as data: it is
 * walked with an explicit stack (so a deeply nested payload can't overflow ours) and never
 * compiled. Fails on depth over 10, more than 1,000 nodes, a `$ref`/`$id` that isn't a local
 * pointer, a `$ref` that points at one of its own ancestors, or a `pattern` over 256 characters.
 */
export function isSchemaWithinLimits(schema: unknown): boolean {
  const stack: Frame[] = [{ value: schema, depth: 0, path: [] }];
  let nodes = 1;
  while (stack.length > 0) {
    const { value, depth, path } = stack.pop()!;
    if (depth > LIMITS.schemaDepth) return false;
    if (value === null || typeof value !== "object") continue;
    const entries: [string, unknown][] = Array.isArray(value)
      ? value.map((item, i) => [String(i), item])
      : Object.entries(value);
    for (const [key, child] of entries) {
      if (!Array.isArray(value)) {
        if (key === "$id" && !(typeof child === "string" && child.startsWith("#"))) return false;
        if (key === "$ref") {
          const target = typeof child === "string" ? decodePointer(child) : undefined;
          if (!target || isPrefix(target, path)) return false;
        }
        if (
          key === "pattern" &&
          typeof child === "string" &&
          child.length > LIMITS.schemaPatternChars
        ) {
          return false;
        }
      }
      if (++nodes > LIMITS.schemaNodes) return false;
      stack.push({ value: child, depth: depth + 1, path: [...path, key] });
    }
  }
  return true;
}
