import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const SELLER_ADDRESS = "GAS7JQRKLXPO5L7OFYDEILAM6AZGPHFJKQ2UJV7TAT5BNXPCXX54L5IF";

describe("loadConfig", () => {
  it("fills the defaults", () => {
    // No facilitator URL: the SDK's default, this project's facilitator.
    expect(loadConfig({ SELLER_ADDRESS })).toEqual({ payTo: SELLER_ADDRESS, port: 4021 });
  });

  it("reads every setting", () => {
    const env = {
      SELLER_ADDRESS,
      FACILITATOR_URL: "http://localhost:4022",
      X402_API_KEY: "sx4_key",
      STELLAR_RPC_URL: "http://localhost:8000",
      PORT: "8080",
    };
    expect(loadConfig(env)).toEqual({
      payTo: SELLER_ADDRESS,
      facilitatorUrl: "http://localhost:4022",
      apiKey: "sx4_key",
      rpcUrl: "http://localhost:8000",
      port: 8080,
    });
  });

  it("treats an empty value as unset", () => {
    const env = {
      SELLER_ADDRESS,
      FACILITATOR_URL: "",
      X402_API_KEY: "",
      STELLAR_RPC_URL: "",
      PORT: "",
    };
    expect(loadConfig(env)).toEqual({ payTo: SELLER_ADDRESS, port: 4021 });
  });

  it("accepts PORT 0, which lets the system pick a free port", () => {
    expect(loadConfig({ SELLER_ADDRESS, PORT: "0" }).port).toBe(0);
  });

  it.each([
    [{}, "SELLER_ADDRESS is required"],
    [{ SELLER_ADDRESS: "GAS7JQRK" }, "SELLER_ADDRESS must be a Stellar account address"],
    [{ SELLER_ADDRESS, FACILITATOR_URL: "x402.org" }, "FACILITATOR_URL must be a URL"],
    [{ SELLER_ADDRESS, STELLAR_RPC_URL: "rpc" }, "STELLAR_RPC_URL must be a URL"],
    [{ SELLER_ADDRESS, PORT: "abc" }, "PORT must be a port number"],
    [{ SELLER_ADDRESS, PORT: "70000" }, "PORT must be between 0 and 65535"],
  ])("refuses %j", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
