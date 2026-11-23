import { SellerFetchError, type SellerFetchCode } from "@stellar-x402/seller-fetch";
import { describe, expect, it } from "vitest";
import { asToolError, type ErrorCode } from "../src/results.js";

describe("asToolError", () => {
  it.each<[SellerFetchCode, ErrorCode]>([
    ["not_a_url", "unsafe_url"],
    ["not_https", "unsafe_url"],
    ["not_public", "unsafe_url"],
    ["redirect", "unsafe_url"],
    ["response_too_large", "response_too_large"],
    ["timeout", "upstream_error"],
    ["network", "upstream_error"],
  ])("gives the agent %s as %s, with the guard's message as is", (cause, code) => {
    const failure = asToolError(new SellerFetchError(cause, "A plain fact."));
    expect(failure).toMatchObject({ code, message: "A plain fact.", detail: cause });
  });

  it("keeps the guard's cause ahead of its detail, for the log only", () => {
    const failure = asToolError(
      new SellerFetchError("network", "failed", "TypeError: fetch failed"),
    );
    expect(failure?.detail).toBe("network: TypeError: fetch failed");
  });

  it("leaves any other error to the caller", () => {
    expect(asToolError(new Error("boom"))).toBeUndefined();
  });
});
