import { Keypair } from "@stellar/stellar-sdk";

export { FakeRpc } from "../src/testing.js";

export const facilitator = Keypair.random();
export const channelKeys = [Keypair.random(), Keypair.random(), Keypair.random()];
export const channels = channelKeys.map((k) => k.publicKey());
