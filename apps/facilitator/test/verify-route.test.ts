import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStores } from "../src/adapters/memory.js";
import { parseConfig } from "../src/config.js";
import { jsonLogger } from "../src/logger.js";
import { start, type Started } from "../src/main.js";
import type { Verify } from "../src/settlement/verify.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  amount: "1000",
  payTo: Keypair.random().publicKey(),
  maxTimeoutSeconds: 60,
  extra: {},
};
const paymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: { transaction: "AAAA" },
};
const request = { x402Version: 2, paymentPayload, paymentRequirements: requirements };

describe("POST /verify", () => {
  const lines: string[] = [];
  const verify = vi.fn<Verify>();
  let app: Started;
  let url: string;

  beforeAll(async () => {
    const env = {
      FACILITATOR_SECRET: Keypair.random().secret(),
      CHANNELS: Keypair.random().publicKey(),
    };
    const config = { ...parseConfig(env), port: 0 };
    const logger = jsonLogger("debug", (line) => lines.push(line));
    app = await start({ config, logger, stores: memoryStores(), verify });
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
        : { isValid, invalidReason: "invalid_exact_stellar_payload_wrong_amount" };
      verify.mockResolvedValueOnce(answer);
      const response = await post(request);
      expect([response.status, await response.json()]).toEqual([200, answer]);
      expect(verify).toHaveBeenCalledWith(paymentPayload, requirements);
    },
  );

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

  it("answers 500 and logs the error when verification throws", async () => {
    verify.mockRejectedValueOnce(new Error("rpc down"));
    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
    expect(lines.join("")).toContain("http_error");
  });
});
