import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiKeyHash, isApiKey, newApiKey } from "../src/index.js";

describe("API keys (0105)", () => {
  it("makes a key of the prefix and 32 random bytes in base64url, new every time", () => {
    const keys = Array.from({ length: 50 }, newApiKey);
    for (const key of keys) {
      expect(key).toMatch(/^x402_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key.slice("x402_".length), "base64url")).toHaveLength(32);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("hashes a key to its SHA-256 in lower-case hex, which the registry takes", () => {
    const key = newApiKey();
    expect(apiKeyHash(key)).toBe(createHash("sha256").update(key, "utf8").digest("hex"));
    expect(apiKeyHash(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("knows a key by its form: the prefix and 43 base64url characters, nothing more", () => {
    expect(isApiKey(newApiKey())).toBe(true);
    for (const key of [
      "",
      newApiKey().slice(0, -1),
      `${newApiKey()}a`,
      `X402_${"a".repeat(43)}`,
      `x402_${"a".repeat(42)}=`,
      `x402_${"a".repeat(42)}/`,
      ` ${newApiKey()}`,
      `${newApiKey()}\n`,
    ])
      expect(isApiKey(key)).toBe(false);
  });
});
