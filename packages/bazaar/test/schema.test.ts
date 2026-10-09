import { describe, expect, it } from "vitest";
import { isSchemaWithinLimits } from "../src/index.js";
import { nested } from "./fixtures.js";

describe("isSchemaWithinLimits", () => {
  it("accepts an ordinary schema and a missing one", () => {
    expect(
      isSchemaWithinLimits({
        type: "object",
        properties: { id: { type: "string", pattern: "^[0-9]+$" } },
        $defs: { id: { type: "string" } },
        items: { $ref: "#/$defs/id" },
      }),
    ).toBe(true);
    expect(isSchemaWithinLimits(undefined)).toBe(true);
  });

  it("enforces depth 10", () => {
    expect(isSchemaWithinLimits(nested(10))).toBe(true);
    expect(isSchemaWithinLimits(nested(11))).toBe(false);
  });

  it("enforces 1,000 nodes", () => {
    expect(isSchemaWithinLimits({ enum: Array.from({ length: 998 }, (_, i) => i) })).toBe(true);
    expect(isSchemaWithinLimits({ enum: Array.from({ length: 1_000 }, (_, i) => i) })).toBe(false);
  });

  it("walks a deeply nested payload without overflowing the stack (RT6)", () => {
    expect(() => isSchemaWithinLimits(nested(100_000))).not.toThrow();
    expect(isSchemaWithinLimits(nested(100_000))).toBe(false);
  });

  it.each([
    ["external $ref", { $ref: "https://example.com/s.json" }],
    ["relative $ref", { $ref: "other.json#/a" }],
    ["external $id", { $id: "https://example.com/s" }],
    ["root self-reference", { properties: { a: { $ref: "#" } } }],
    ["ancestor self-reference", { $defs: { a: { items: { $ref: "#/$defs/a" } } } }],
    ["non-string $ref", { $ref: { a: 1 } }],
    ["long pattern", { pattern: "a".repeat(257) }],
  ])("rejects %s", (_, schema) => {
    expect(isSchemaWithinLimits(schema)).toBe(false);
  });
});
