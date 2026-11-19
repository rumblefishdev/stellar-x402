import { newApiKey } from "@stellar-x402/api-keys";
import { describe, expect, it } from "vitest";
import { bearerApiKey, requiresApiKey } from "../src/http/api-key.js";

describe("API keys (0105)", () => {
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
