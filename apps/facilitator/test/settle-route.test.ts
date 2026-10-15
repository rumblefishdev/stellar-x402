import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStores } from "../src/adapters/memory.js";
import { parseConfig } from "../src/config.js";
import { jsonLogger } from "../src/logger.js";
import { start, type Started } from "../src/main.js";
import type { SettlementRecord } from "../src/ports/index.js";
import type { SettlementHooks } from "../src/settlement/hooks.js";
import type { Settle } from "../src/settlement/settle.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  amount: "1000",
  payTo: Keypair.random().publicKey(),
  maxTimeoutSeconds: 60,
  extra: {},
};
// `accepted` differs from the requirements, so the test sees which one reaches the settler.
const paymentPayload = {
  x402Version: 2,
  accepted: { ...requirements, amount: "1" },
  payload: { transaction: "AAAA" },
};
const request = { x402Version: 2, paymentPayload, paymentRequirements: requirements };
const success = {
  success: true,
  transaction: "a".repeat(64),
  network: "stellar:testnet",
  payer: "GPAYER",
} as const;
const record = { key: "stellar:testnet:GPAYER:7" } as unknown as SettlementRecord;

describe("POST /settle", () => {
  const lines: string[] = [];
  const settle = vi.fn<Settle>();
  const extensionResponses = vi.fn<SettlementHooks["extensionResponses"]>();
  let app: Started;
  let url: string;

  beforeAll(async () => {
    const env = {
      FACILITATOR_SECRET: Keypair.random().secret(),
      CHANNELS: Keypair.random().publicKey(),
    };
    const config = { ...parseConfig(env), port: 0 };
    const logger = jsonLogger("debug", (line) => lines.push(line));
    app = await start({
      config,
      logger,
      stores: memoryStores(),
      verify: async () => ({ isValid: true }),
      settle,
      extensionResponses,
    });
    url = `http://127.0.0.1:${app.port}/settle`;
  });
  afterAll(() => app.close());
  beforeEach(() => {
    settle.mockReset();
    extensionResponses.mockReset();
    lines.length = 0;
  });

  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("answers 200 with a success body and the EXTENSION-RESPONSES header, then runs afterResponse", async () => {
    const afterResponse = vi.fn();
    settle.mockResolvedValueOnce({ response: success, record, afterResponse, key: record.key });
    extensionResponses.mockReturnValueOnce({ bazaar: { status: "processing" } });

    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([200, success]);
    expect(settle).toHaveBeenCalledWith(paymentPayload, requirements, expect.any(AbortSignal));
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "settled", settlementKey: record.key, replay: false }),
    );
    expect(extensionResponses).toHaveBeenCalledWith(record);
    const header = response.headers.get("extension-responses");
    expect(JSON.parse(Buffer.from(header!, "base64").toString())).toEqual({
      bazaar: { status: "processing" },
    });
    await vi.waitFor(() => expect(afterResponse).toHaveBeenCalledTimes(1));
  });

  it("tells the settler when the client leaves before the answer", async () => {
    let aborted!: (value: boolean) => void;
    const seen = new Promise<boolean>((resolve) => (aborted = resolve));
    settle.mockImplementationOnce(
      (_payload, _requirements, signal) =>
        new Promise((resolve) => {
          signal!.addEventListener("abort", () => {
            aborted(true);
            resolve({ response: success });
          });
        }),
    );
    const client = new AbortController();
    const request_ = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: client.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(settle).toHaveBeenCalled());
    client.abort();
    await request_;
    expect(await seen).toBe(true);
  });

  it("sends no header when there are no extension responses or the answer is a failure", async () => {
    settle.mockResolvedValueOnce({ response: success, record });
    extensionResponses.mockReturnValueOnce(undefined);
    expect((await post(request)).headers.get("extension-responses")).toBeNull();

    const failure = {
      success: false,
      errorReason: "settlement_pending",
      transaction: "a".repeat(64),
      network: "stellar:testnet",
    } as const;
    settle.mockResolvedValueOnce({ response: failure });
    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([200, failure]);
    expect(response.headers.get("extension-responses")).toBeNull();
    expect(extensionResponses).toHaveBeenCalledTimes(1);
  });

  it("keeps the success answer when the header can't be computed", async () => {
    settle.mockResolvedValueOnce({ response: success, record });
    extensionResponses.mockImplementationOnce(() => {
      throw new Error("bazaar bug");
    });
    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([200, success]);
    expect(lines.join("")).toContain("extension_responses_failed");
  });

  it("answers 400 for a bad body, without settling", async () => {
    const response = await post({ ...request, x402Version: 1 });
    expect([response.status, await response.json()]).toEqual([400, { error: "bad_request" }]);
    expect(settle).not.toHaveBeenCalled();
  });

  it("answers 500 and logs the error when settling throws", async () => {
    settle.mockRejectedValueOnce(new Error("store down"));
    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
    expect(lines.join("")).toContain("http_error");
  });
});
