import {
  Operation,
  StrKey,
  TransactionBuilder,
  type Account,
  type Keypair,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { SorobanRpc } from "./types.js";

/** Base reserve (0.5 XLM) x (2 + one extra signer): a channel never pays fees itself. */
export const CHANNEL_STARTING_BALANCE = "1.5";

export interface CreateChannelsOptions {
  /** The facilitator account: funds the channels, becomes their signer, is the tx source. */
  facilitator: Account;
  /** Fresh keys for the new channels. Their secrets are not needed after this transaction. */
  channels: readonly Keypair[];
  networkPassphrase: string;
  /** Inclusion fee per operation, in stroops. */
  fee?: number;
  startingBalance?: string;
  /**
   * Set each channel's master key weight to 0, so only the facilitator key can sign for it.
   * Default true: the channel secrets can then be thrown away.
   */
  disableMasterKey?: boolean;
}

/**
 * Most channels one {@link buildCreateChannelsTx} transaction can create: it needs the
 * facilitator's signature plus one per channel, and a transaction holds at most 20 signatures.
 */
export const MAX_CHANNELS_PER_TX = 19;

/**
 * Builds one classic transaction that creates the channels and makes the facilitator a signer
 * on each (2 operations per channel). It must be signed by the facilitator and by every channel
 * key, because each channel's `setOptions` uses it as source.
 */
export function buildCreateChannelsTx(opts: CreateChannelsOptions): Transaction {
  const { facilitator, channels } = opts;
  if (channels.length === 0 || channels.length > MAX_CHANNELS_PER_TX)
    throw new Error(`create between 1 and ${MAX_CHANNELS_PER_TX} channels per transaction`);
  const builder = new TransactionBuilder(facilitator, {
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
        signer: { ed25519PublicKey: facilitator.accountId(), weight: 1 },
        ...(opts.disableMasterKey === false ? {} : { masterWeight: 0 }),
      }),
    );
  }
  return builder.build();
}

export type ChannelProblem = "missing" | "facilitator-not-signer" | "thresholds-too-high";

/**
 * Checks that a channel exists and that the facilitator's signature alone authorizes it
 * (signer weight at least the medium threshold, which transactions and payments need).
 */
export async function checkChannel(
  rpc: Pick<SorobanRpc, "getAccountEntry">,
  channel: string,
  facilitator: string,
): Promise<ChannelProblem | undefined> {
  let entry;
  try {
    entry = await rpc.getAccountEntry(channel);
  } catch {
    return "missing";
  }
  const signer = entry
    .signers()
    .find(
      (s) =>
        s.key().switch().name === "signerKeyTypeEd25519" &&
        StrKey.encodeEd25519PublicKey(s.key().ed25519()) === facilitator,
    );
  if (!signer) return "facilitator-not-signer";
  // Thresholds are [master weight, low, medium, high]. Most operations need medium.
  const medium = entry.thresholds()[2] ?? 0;
  if (signer.weight() < Math.max(1, medium)) return "thresholds-too-high";
  return undefined;
}
