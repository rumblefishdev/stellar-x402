import { Address, FeeBumpTransaction, StrKey, xdr, type rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  SettlementSubmitter,
  keypairSigner,
  type SubmitterEvent,
  type SubmitterOptions,
} from "../src/index.js";
import { FakeRpc, channels, facilitator } from "./fake-rpc.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

const call = () => ({
  func: xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(StrKey.encodeContract(Buffer.alloc(32, 7))).toScAddress(),
      functionName: "settle_upto",
      args: [],
    }),
  ),
  auth: [],
});

function setup(opts: Partial<SubmitterOptions> = {}, n = 1) {
  const fake = new FakeRpc(
    Object.fromEntries([
      [facilitator.publicKey(), 500n],
      ...channels.map((c, i) => [c, BigInt(1000 * (i + 1))]),
    ]),
  );
  const events: SubmitterEvent[] = [];
  const submitter = new SettlementSubmitter({
    rpc: fake,
    networkPassphrase: PASSPHRASE,
    signer: keypairSigner(facilitator),
    channels: channels.slice(0, n),
    inclusionFee: 100,
    now: () => fake.closeTime * 1000,
    sleep: async () => {},
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { fake, submitter, events };
}

/** The inclusion fee bid of each sent envelope: the inner fee minus the simulated resource fee. */
const bids = (fake: FakeRpc) =>
  fake.sent.map((t) => Number((t as FeeBumpTransaction).innerTransaction.fee) - fake.resourceFee);
const raises = (events: SubmitterEvent[]) =>
  events.flatMap((e) => (e.type === "fee-raised" ? [e.bid] : []));

describe("fee escalation", () => {
  it("is off by default", async () => {
    const { fake, submitter, events } = setup();
    await Promise.all(Array.from({ length: 4 }, () => submitter.submit(call())));
    expect(bids(fake)).toEqual([100, 100, 100, 100]);
    expect(raises(events)).toEqual([]);
  });

  it("multiplies the bid per full round of waiting calls and falls back as the queue drains", async () => {
    const { fake, submitter, events } = setup({ feeEscalation: {} });
    // One channel and four calls: 3, 2, 1 and 0 calls wait when each envelope is built.
    await Promise.all(Array.from({ length: 4 }, () => submitter.submit(call())));
    expect(bids(fake)).toEqual([800, 400, 200, 100]);
    expect(raises(events)).toEqual([800, 400, 200]);
    expect(submitter.stats().feeRaises).toEqual({ count: 3, highestBid: 800 });
  });

  it("counts the backlog in rounds of the whole pool", async () => {
    const { fake, submitter } = setup({ feeEscalation: {} }, 2);
    // Two channels and five calls: 3 wait for the first two envelopes (one round), then fewer
    // than two.
    await Promise.all(Array.from({ length: 5 }, () => submitter.submit(call())));
    expect(bids(fake)).toEqual([200, 200, 100, 100, 100]);
  });

  it("caps the raise at max and never bids below the base", async () => {
    const capped = setup({ feeEscalation: { factor: 10, max: 1_000 } });
    await Promise.all(Array.from({ length: 4 }, () => capped.submitter.submit(call())));
    expect(bids(capped.fake)).toEqual([1_000, 1_000, 1_000, 100]);

    const high = setup({ inclusionFee: 5_000, feeEscalation: { max: 1_000 } });
    await Promise.all(Array.from({ length: 3 }, () => high.submitter.submit(call())));
    expect(bids(high.fake)).toEqual([5_000, 5_000, 5_000]);
    expect(raises(high.events)).toEqual([]);
  });

  it("stops at the default ceiling of 1,000 stroops", async () => {
    const { fake, submitter } = setup({ feeEscalation: {} });
    // One channel and six calls: 5 waiting would give 100 x 2^5 = 3,200.
    await Promise.all(Array.from({ length: 6 }, () => submitter.submit(call())));
    expect(bids(fake)[0]).toBe(1_000);
  });

  it("lowers a raised bid to fit maxFeeStroops instead of refusing the call", async () => {
    // Resource fee 40,000 + 2 x bid must stay within 41,000: the bid can be at most 500.
    const { fake, submitter, events } = setup({ feeEscalation: {}, maxFeeStroops: 41_000 });
    const results = await Promise.all(Array.from({ length: 4 }, () => submitter.submit(call())));
    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(bids(fake)).toEqual([500, 400, 200, 100]);
    expect(raises(events)).toEqual([500, 400, 200]);
  });

  it("counts the bid twice under a fee bump, not three times", async () => {
    // 40,000 + 2 x 100 = 40,200 fits exactly.
    const { submitter } = setup({ maxFeeStroops: 40_200 });
    expect((await submitter.submit(call())).status).toBe("success");
  });

  it("bids from getFeeStats by default", async () => {
    const { fake, submitter } = setup({ inclusionFee: undefined });
    fake.feeStats = {
      sorobanInclusionFee: { p90: "300" },
    } as unknown as rpc.Api.GetFeeStatsResponse;
    await submitter.submit(call());
    expect(bids(fake)).toEqual([300]);
  });

  it("rejects a factor that would not raise the bid", () => {
    expect(() => setup({ feeEscalation: { factor: 1 } })).toThrow("factor must be above 1");
  });
});
