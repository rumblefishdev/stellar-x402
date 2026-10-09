import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");
const FORBIDDEN = [
  /from "node:/,
  /from "(fs|net|http|https|dns|child_process|ajv)"/,
  /(?<![\w-])process\./,
  /\bDate\b/,
  /\bfetch\(/,
  /\bcompile\(/,
];

describe("packages/bazaar is pure", () => {
  it.each(readdirSync(SRC).filter((file) => file.endsWith(".ts")))(
    "%s does no I/O, reads no env or clock, and compiles no schema",
    (file) => {
      const source = readFileSync(join(SRC, file), "utf8");
      for (const pattern of FORBIDDEN) expect(source).not.toMatch(pattern);
    },
  );
});
