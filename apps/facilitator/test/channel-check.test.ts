import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { checkChannels } from "../src/settlement/channel-check.js";
import { accountEntry, type StubAccount } from "./rpc-stub.js";

const facilitator = Keypair.random().publicKey();
const good = Keypair.random().publicKey();
const masterActive = Keypair.random().publicKey();
const missing = Keypair.random().publicKey();
const unreadable = Keypair.random().publicKey();

const entry = (address: string, account: StubAccount) =>
  accountEntry(Keypair.fromPublicKey(address).xdrAccountId(), account);

const rpc = {
  getAccountEntry: async (address: string) => {
    if (address === good) return entry(address, { signers: [facilitator], masterWeight: 0 });
    if (address === masterActive)
      return entry(address, { signers: [facilitator], masterWeight: 1 });
    if (address === unreadable) throw new Error("fetch failed");
    throw new Error(`Account not found: ${address}`);
  },
};

describe("checkChannels", () => {
  it("passes when every channel has the facilitator as its only signer and no master key", async () => {
    await expect(checkChannels(rpc, [good], facilitator)).resolves.toBeUndefined();
  });

  it("names every failing channel with its problem, and none that passed", async () => {
    const error = await checkChannels(rpc, [good, masterActive, missing], facilitator).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    expect(message).toContain(`${masterActive}: master-key-active`);
    expect(message).toContain(`${missing}: missing`);
    expect(message).not.toContain(good);
  });

  it("names a channel whose read failed with the error, next to the others' problems", async () => {
    // One failed read must not hide what the other channels answered.
    const error = await checkChannels(rpc, [unreadable, masterActive], facilitator).catch(
      (e: unknown) => e,
    );
    const { message } = error as Error;
    expect(message).toContain(`${unreadable}: fetch failed`);
    expect(message).toContain(`${masterActive}: master-key-active`);
  });
});
