import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_DEPTH } from "../src/http/app.js";
import { parseConfig } from "../src/config.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import { start, type Started } from "../src/main.js";
import type { Verify } from "../src/settlement/verify.js";
import { testDatabase } from "./database.js";
import { bazaarExtensions, depthOf } from "./payment.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  amount: "1000",
  payTo: Keypair.random().publicKey(),
  maxTimeoutSeconds: 60,
  extra: {},
};
// `accepted` differs from the requirements, so the test sees which one reaches the verifier.
const paymentPayload = {
  x402Version: 2,
  accepted: { ...requirements, amount: "1" },
  payload: { transaction: "AAAA" },
};
const request = { x402Version: 2, paymentPayload, paymentRequirements: requirements };

describe("POST /verify", () => {
  const db = testDatabase();
  const lines: string[] = [];
  const verify = vi.fn<Verify>();
  let app: Started;
  let url: string;

  beforeAll(async () => {
    const env = {
      FACILITATOR_SECRET: Keypair.random().secret(),
      CLIENT_IP: "socket",
      CHANNELS: Keypair.random().publicKey(),
    };
    const config = { ...parseConfig(env), port: 0 };
    const logger = jsonLogger("debug", (line) => lines.push(line));
    app = await start({
      config,
      logger,
      metrics: memoryMetrics(),
      stores: db.stores(),
      verify,
      settle: async () => {
        throw new Error("not used");
      },
      extensionResponses: () => undefined,
      supported: supportedResponse(config.network, Keypair.random().publicKey()),
    });
    url = `http://127.0.0.1:${app.port}/verify`;
  });
  afterAll(() => app.close());
  beforeEach(() => {
    verify.mockReset();
    lines.length = 0;
  });

  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it.each([true, false])(
    "answers 200 with the verifier's body when isValid is %s",
    async (isValid) => {
      const answer: VerifyResponse = isValid
        ? { isValid, payer: "GPAYER" }
        : {
            isValid,
            invalidReason: "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
            invalidMessage: "the payload uses a facilitator channel account",
            payer: "GPAYER",
            extra: { reason: "invalid_exact_stellar_payload_channel_account" },
          };
      verify.mockResolvedValueOnce(answer);
      const response = await post(request);
      expect([response.status, await response.json()]).toEqual([200, answer]);
      expect(verify).toHaveBeenCalledWith(paymentPayload, requirements, expect.any(Object));
    },
  );

  it("logs the RPC URL that answered", async () => {
    verify.mockImplementationOnce(async (_payload, _requirements, trace) => {
      trace!.rpc = "RPC_URLS[1]";
      return { isValid: false, invalidReason: "invalid_exact_stellar_payload_simulation_failed" };
    });
    await post(request);
    const verified = lines.map((line) => JSON.parse(line)).find((l) => l.event === "verified");
    expect(verified).toMatchObject({ isValid: false, rpc: "RPC_URLS[1]" });
  });

  it("logs our own reason next to upstream's", async () => {
    verify.mockResolvedValueOnce({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
      extra: { reason: "invalid_exact_stellar_payload_channel_account" },
    });
    await post(request);
    const verified = lines.map((line) => JSON.parse(line)).find((l) => l.event === "verified");
    expect(verified).toMatchObject({
      invalidReason: "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
      reason: "invalid_exact_stellar_payload_channel_account",
    });
  });

  it.each([
    ["an empty object", {}],
    ["an array", [request]],
    ["x402 v1", { ...request, x402Version: 1 }],
    ["a v1 payment payload", { ...request, paymentPayload: { ...paymentPayload, x402Version: 1 } }],
    ["no requirements", { x402Version: 2, paymentPayload }],
    [
      "requirements without payTo",
      { ...request, paymentRequirements: { ...requirements, payTo: undefined } },
    ],
    [
      "a non-numeric timeout",
      { ...request, paymentRequirements: { ...requirements, maxTimeoutSeconds: "60" } },
    ],
  ])("answers 400 for %s, without verifying", async (_, body) => {
    const response = await post(body);
    expect([response.status, await response.json()]).toEqual([400, { error: "bad_request" }]);
    expect(verify).not.toHaveBeenCalled();
  });

  // Upstream's `BigInt(amount)` would throw on these, which is a 500, not a verdict.
  it.each(["1.5", "1e3", "abc", "-5", " 1"])(
    "answers 400 for the amount %j, without verifying",
    async (amount) => {
      const response = await post({ ...request, paymentRequirements: { ...requirements, amount } });
      expect([response.status, await response.json()]).toEqual([400, { error: "bad_request" }]);
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it("verifies the payload upstream's client builds for a Bazaar resource with a deep output schema", async () => {
    verify.mockResolvedValue({ isValid: true, payer: "GPAYER" });
    const body = {
      ...request,
      paymentPayload: { ...paymentPayload, extensions: bazaarExtensions(6) },
    };
    // Deeper than the old cap of 32 (0009 decision 39).
    expect(depthOf(body)).toBeGreaterThan(32);
    expect((await post(body)).status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("verifies a body nested to MAX_BODY_DEPTH, and refuses one level deeper", async () => {
    // `paymentPayload.extensions.deep` holds `levels` arrays; the innermost is at depth levels + 2.
    const nested = (levels: number) => {
      let deep: unknown = 0;
      for (let i = 0; i < levels; i++) deep = [deep];
      return { ...request, paymentPayload: { ...paymentPayload, extensions: { deep } } };
    };
    verify.mockResolvedValue({ isValid: true, payer: "GPAYER" });
    expect((await post(nested(MAX_BODY_DEPTH - 3))).status).toBe(200);
    expect((await post(nested(MAX_BODY_DEPTH - 2))).status).toBe(400);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("answers 400 for a NUL or a lone surrogate in any string or key, without verifying", async () => {
    for (const text of ["a\u0000b", "a\ud800b"]) {
      const bodies = [
        { ...request, paymentRequirements: { ...requirements, payTo: text } },
        { ...request, paymentPayload: { ...paymentPayload, extensions: { [text]: 1 } } },
      ];
      for (const body of bodies) {
        const response = await post(body);
        expect([response.status, await response.json()]).toEqual([400, { error: "bad_request" }]);
      }
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("sends no CORS headers", async () => {
    verify.mockResolvedValueOnce({ isValid: true, payer: "GPAYER" });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://other.example" },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers 500 and logs the error when verification throws", async () => {
    verify.mockRejectedValueOnce(new Error("rpc down"));
    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
    expect(lines.join("")).toContain("http_error");
  });
});
