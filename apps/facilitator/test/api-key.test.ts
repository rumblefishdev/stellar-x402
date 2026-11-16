import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiKeyHash, bearerApiKey, newApiKey, requiresApiKey } from "../src/http/api-key.js";

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

  it("reads a well-formed key from an Authorization header", () => {
    const key = newApiKey();
    expect(bearerApiKey(`Bearer ${key}`)).toBe(key);
    expect(bearerApiKey(`bearer   ${key}`)).toBe(key);
  });

  it.each([
    ["", "an empty header"],
    ["Bearer", "a scheme with no key"],
    ["Bearer ", "a scheme and a space"],
    [`Basic ${newApiKey()}`, "another scheme"],
    [newApiKey(), "a key with no scheme"],
    [`Bearer${newApiKey()}`, "no space after the scheme"],
    [`Bearer\t${newApiKey()}`, "a tab after the scheme"],
    [`Bearer ${newApiKey()} `, "a space after the key"],
    [`Bearer ${newApiKey()}\n`, "a line end after the key"],
    [`Bearer ${newApiKey().slice(0, -1)}`, "a key one character short"],
    [`Bearer ${newApiKey()}a`, "a key one character long"],
    [`Bearer X402_${"a".repeat(43)}`, "an upper-case prefix"],
    [`Bearer x402_${"a".repeat(42)}=`, "base64 padding"],
    [`Bearer x402_${"a".repeat(42)}/`, "a character outside base64url"],
    [`Bearer ${newApiKey()}, Bearer ${newApiKey()}`, "a header sent twice"],
  ])("reads no key from %j (%s)", (header) => {
    expect(bearerApiKey(header)).toBeUndefined();
  });

  it("requires a key on stellar:pubnet only, whatever else a body names", () => {
    expect(requiresApiKey("stellar:pubnet")).toBe(true);
    for (const network of [
      "stellar:testnet",
      "stellar:PUBNET",
      " stellar:pubnet",
      "eip155:8453",
      "",
      undefined,
      null,
      ["stellar:pubnet"],
      { network: "stellar:pubnet" },
    ])
      expect(requiresApiKey(network)).toBe(false);
  });
});
