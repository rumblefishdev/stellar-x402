import { describe, expect, it } from "vitest";
import { isStellarNetwork } from "../src/index.js";

describe("isStellarNetwork", () => {
  it("accepts the supported networks", () => {
    expect(isStellarNetwork("stellar:testnet")).toBe(true);
    expect(isStellarNetwork("stellar:pubnet")).toBe(true);
  });

  it("rejects other networks", () => {
    expect(isStellarNetwork("eip155:8453")).toBe(false);
  });
});
