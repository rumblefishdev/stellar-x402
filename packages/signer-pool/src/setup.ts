import {
  Operation,
  StrKey,
  TransactionBuilder,
  type Account,
  type Keypair,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import { readAccountEntry } from "./account.js";
import type { SorobanRpc } from "./types.js";

/** Base reserve (0.5 XLM) x (2 + one extra signer): a channel never pays fees itself. */
export const CHANNEL_STARTING_BALANCE = "1.5";

export interface CreateChannelsOptions {
  /**
   * Funds the channels and is the tx source. It may be any account: an ordinary wallet funds the
   * channels of a key held in OpenBao, which then signs nothing here (0036).
   */
  funder: Account;
  /** The facilitator key's address: each channel's only signer. */
  signer: string;
  /** Fresh keys for the new channels. Their secrets are not needed after this transaction. */
  channels: readonly Keypair[];
  networkPassphrase: string;
  /** Inclusion fee per operation, in stroops. */
  fee?: number;
  startingBalance?: string;
}

/**
 * Most channels one {@link buildCreateChannelsTx} transaction can create: it needs the
 * funder's signature plus one per channel, and a transaction holds at most 20 signatures.
 */
export const MAX_CHANNELS_PER_TX = 19;

/**
 * Builds one classic transaction that creates the channels and makes the facilitator key a signer
 * on each (2 operations per channel). It must be signed by the funder and by every channel key,
 * because each channel's `setOptions` uses it as source; the facilitator key doesn't sign.
 */
export function buildCreateChannelsTx(opts: CreateChannelsOptions): Transaction {
  const { funder, signer, channels } = opts;
  if (channels.length === 0 || channels.length > MAX_CHANNELS_PER_TX)
    throw new Error(`create between 1 and ${MAX_CHANNELS_PER_TX} channels per transaction`);
  const builder = new TransactionBuilder(funder, {
    fee: String(opts.fee ?? 100),
    networkPassphrase: opts.networkPassphrase,
  }).setTimeout(120);
  for (const ch of channels) {
    builder.addOperation(
      Operation.createAccount({
        destination: ch.publicKey(),
        startingBalance: opts.startingBalance ?? CHANNEL_STARTING_BALANCE,
      }),
    );
    builder.addOperation(
      Operation.setOptions({
        source: ch.publicKey(),
        signer: { ed25519PublicKey: signer, weight: 1 },
        // Only the facilitator key can sign for the channel, so its secret can be thrown away.
        masterWeight: 0,
      }),
    );
  }
  return builder.build();
}

export type ChannelProblem =
  | "missing"
  | "facilitator-not-signer"
  | "thresholds-too-high"
  | "master-key-active"
  | "extra-signer";

/**
 * Checks that a channel exists and that the facilitator is its only signer: the facilitator's
 * weight meets the medium threshold (which transactions and payments need), the master key
 * weight is 0, and no other key can sign. Only an answer with no entry is reported as `missing`;
 * other RPC errors are thrown, since they say nothing about the channel.
 */
export async function checkChannel(
  rpc: Pick<SorobanRpc, "getLedgerEntries">,
  channel: string,
  facilitator: string,
): Promise<ChannelProblem | undefined> {
  const entry = await readAccountEntry(rpc, channel);
  if (!entry) return "missing";
  const isFacilitator = (s: xdr.Signer) =>
    s.key().switch().name === "signerKeyTypeEd25519" &&
    StrKey.encodeEd25519PublicKey(s.key().ed25519()) === facilitator;
  const signer = entry.signers().find(isFacilitator);
  if (!signer) return "facilitator-not-signer";
  // Thresholds are [master weight, low, medium, high]. Most operations need medium.
  const [masterWeight = 0, , medium = 0] = entry.thresholds();
  if (signer.weight() < Math.max(1, medium)) return "thresholds-too-high";
  if (masterWeight > 0) return "master-key-active";
  if (entry.signers().some((s) => !isFacilitator(s) && s.weight() > 0)) return "extra-signer";
  return undefined;
}
