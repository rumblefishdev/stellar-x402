import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const SELLER_ADDRESS = "GAS7JQRKLXPO5L7OFYDEILAM6AZGPHFJKQ2UJV7TAT5BNXPCXX54L5IF";

describe("loadConfig", () => {
  it("fills the defaults", () => {
    expect(loadConfig({ SELLER_ADDRESS })).toEqual({
      payTo: SELLER_ADDRESS,
      facilitatorUrl: "https://www.x402.org/facilitator",
      port: 4021,
    });
  });

  it("reads every setting", () => {
    const env = { SELLER_ADDRESS, FACILITATOR_URL: "http://localhost:4022", PORT: "8080" };
    expect(loadConfig(env)).toEqual({
      payTo: SELLER_ADDRESS,
      facilitatorUrl: "http://localhost:4022",
      port: 8080,
    });
  });

  it("treats an empty value as unset", () => {
    expect(loadConfig({ SELLER_ADDRESS, FACILITATOR_URL: "", PORT: "" })).toMatchObject({
      facilitatorUrl: "https://www.x402.org/facilitator",
      port: 4021,
    });
  });

  it("reads the public origin and drops a trailing slash", () => {
    expect(
      loadConfig({ SELLER_ADDRESS, PUBLIC_ORIGIN: "https://seller.example.com/" }).publicOrigin,
    ).toBe("https://seller.example.com");
  });

  it("leaves the public origin out when it is unset or empty", () => {
    expect(loadConfig({ SELLER_ADDRESS })).not.toHaveProperty("publicOrigin");
    expect(loadConfig({ SELLER_ADDRESS, PUBLIC_ORIGIN: "" })).not.toHaveProperty("publicOrigin");
  });

  it("accepts PORT 0, which lets the system pick a free port", () => {
    expect(loadConfig({ SELLER_ADDRESS, PORT: "0" }).port).toBe(0);
  });

  it.each([
    [{}, "SELLER_ADDRESS is required"],
    [{ SELLER_ADDRESS: "GAS7JQRK" }, "SELLER_ADDRESS must be a Stellar account address"],
    [{ SELLER_ADDRESS, FACILITATOR_URL: "x402.org" }, "FACILITATOR_URL must be a URL"],
    [{ SELLER_ADDRESS, PORT: "abc" }, "PORT must be a port number"],
    [{ SELLER_ADDRESS, PORT: "70000" }, "PORT must be between 0 and 65535"],
    [{ SELLER_ADDRESS, PUBLIC_ORIGIN: "seller.example.com" }, "PUBLIC_ORIGIN must be a URL"],
    [{ SELLER_ADDRESS, PUBLIC_ORIGIN: "http://seller.example.com" }, "PUBLIC_ORIGIN must be https"],
    [
      { SELLER_ADDRESS, PUBLIC_ORIGIN: "https://seller.example.com/weather" },
      "PUBLIC_ORIGIN must be an origin only",
    ],
    [
      { SELLER_ADDRESS, PUBLIC_ORIGIN: "https://seller.example.com?a=1" },
      "PUBLIC_ORIGIN must be an origin only",
    ],
  ])("refuses %j", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
