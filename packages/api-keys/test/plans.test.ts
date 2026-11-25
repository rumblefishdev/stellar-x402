import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_PLANS, parseAccountPlans } from "../src/index.js";

describe("account plans (0107)", () => {
  it("reads the default line as the three plans", () => {
    expect([...parseAccountPlans(DEFAULT_ACCOUNT_PLANS).values()]).toEqual([
      { name: "free", payments: 1_000, dailyFeeStroops: 20_000_000n },
      { name: "basic", payments: 10_000, dailyFeeStroops: 25_000_000n },
      { name: "pro", payments: 100_000, dailyFeeStroops: 100_000_000n },
    ]);
  });

  it("takes spaces around an entry, as the other lists in the config", () => {
    expect([...parseAccountPlans(" free:1:1 , pro:2:2 ").keys()]).toEqual(["free", "pro"]);
  });

  it.each([
    ["basic:10", "an entry without its fee"],
    ["free:x:1", "payments that aren't a number"],
    ["free:1:x", "a fee that isn't a number"],
    ["free:1:1:1", "an entry with a part too many"],
    ["free:-1:1", "a sign"],
    ["free:0:1", "no payments"],
    ["free:1:0", "no fee"],
    ["free:9007199254740992:1", "payments past the largest safe integer"],
    ["free:1:9223372036854775808", "a fee past what the store holds"],
    ["Free:1:1", "an upper-case name"],
    [":1:1", "no name"],
    ["free:1:1,free:2:2", "a name twice"],
    ["basic:1:1,pro:2:2", "no free plan, which an account without a plan row is on"],
    ["", "no plan at all"],
  ])("refuses %j (%s)", (text) => {
    expect(() => parseAccountPlans(text)).toThrow(RangeError);
  });
});
