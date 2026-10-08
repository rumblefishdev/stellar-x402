import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

const SECRET = `S${"A".repeat(55)}`;
const CHANNEL_A = `G${"A".repeat(55)}`;
const CHANNEL_B = `G${"B".repeat(55)}`;

const minimal = { FACILITATOR_SECRET: SECRET, CHANNELS: `${CHANNEL_A}, ${CHANNEL_B}` };

function problems(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
  it("applies testnet defaults to a minimal environment", () => {
    const config = parseConfig(minimal);
    expect(config.network).toBe("stellar:testnet");
    expect(config.port).toBe(4021);
    expect(config.rpcUrls).toEqual(["https://soroban-testnet.stellar.org"]);
    expect(config.channels).toEqual([CHANNEL_A, CHANNEL_B]);
    expect(config.store).toBe("memory");
    expect(config.fees.maxFeeStroops).toBe(250_000n);
    expect(config.fees.inclusionFeeStroops).toBeUndefined();
    expect(config.fees.escalation).toBeUndefined();
    expect(config.spend.globalStroops).toBe(5_000_000_000n);
  });

  it("parses fee settings and an RPC fallback list", () => {
    const config = parseConfig({
      ...minimal,
      RPC_URLS: "https://a.example, https://b.example",
      INCLUSION_FEE_STROOPS: "200",
      FEE_ESCALATION_FACTOR: "2",
      FEE_ESCALATION_MAX_STROOPS: "1000",
    });
    expect(config.rpcUrls).toEqual(["https://a.example", "https://b.example"]);
    expect(config.fees.inclusionFeeStroops).toBe(200n);
    expect(config.fees.escalation).toEqual({ factor: 2, max: 1000 });
  });

  it("treats blank values as unset", () => {
    expect(parseConfig({ ...minimal, RPC_URLS: "", PORT: " " }).port).toBe(4021);
  });

  it("names missing required values", () => {
    expect(problems({})).toEqual(["FACILITATOR_SECRET is required", "CHANNELS is required"]);
  });

  it("names an invalid value without echoing it", () => {
    const leaked = `S${"Z".repeat(54)}`;
    const found = problems({ ...minimal, FACILITATOR_SECRET: leaked, PORT: "seventy" });
    expect(found).toEqual([
      "PORT is invalid",
      "FACILITATOR_SECRET must be a Stellar secret key (S…)",
    ]);
    expect(found.join(" ")).not.toContain(leaked);
  });

  it("refuses an inclusion fee under 100 stroops", () => {
    expect(problems({ ...minimal, INCLUSION_FEE_STROOPS: "99" })).toEqual([
      "INCLUSION_FEE_STROOPS must be at least 100",
    ]);
  });

  it("requires RPC URLs outside testnet", () => {
    expect(problems({ ...minimal, NETWORK: "stellar:pubnet" })).toEqual([
      "RPC_URLS is required outside testnet",
    ]);
  });
});
