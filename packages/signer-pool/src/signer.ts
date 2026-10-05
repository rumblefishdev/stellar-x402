import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { TransactionSigner } from "./types.js";

/** A {@link TransactionSigner} backed by an in-memory key. */
export function keypairSigner(keypair: Keypair): TransactionSigner {
  return {
    address: keypair.publicKey(),
    async signTransaction(xdr, { networkPassphrase }) {
      const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
    },
  };
}
