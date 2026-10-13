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

  it.each([
    [{}, "SELLER_ADDRESS is required"],
    [{ SELLER_ADDRESS: "GAS7JQRK" }, "SELLER_ADDRESS must be a Stellar account address"],
    [{ SELLER_ADDRESS, FACILITATOR_URL: "x402.org" }, "FACILITATOR_URL must be a URL"],
    [{ SELLER_ADDRESS, PORT: "abc" }, "PORT must be a port number"],
    [{ SELLER_ADDRESS, PORT: "0" }, "PORT must be between 1 and 65535"],
    [{ SELLER_ADDRESS, PORT: "70000" }, "PORT must be between 1 and 65535"],
  ])("refuses %j", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
