import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";

/** An account as the stub serves it: its signers and its master key weight. */
export interface StubAccount {
  signers: { key: string; weight: number }[];
  masterWeight: number;
}

/** A channel set up as AD-12 requires: master key weight 0, the facilitator its only signer. */
export const hardened = (facilitator: string): StubAccount => ({
  signers: [{ key: facilitator, weight: 1 }],
  masterWeight: 0,
});

/**
 * A Stellar RPC over HTTP for `main()`, which builds its own RPC from `RPC_URLS`: it answers
 * `getLedgerEntries` for `accounts` (any other account doesn't exist), and every other method
 * with a 503.
 */
export async function rpcStub(
  accounts: Record<string, StubAccount>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: { keys: string[] };
      };
      if (method !== "getLedgerEntries") {
        res.writeHead(503).end();
        return;
      }
      const entries = params.keys.flatMap((key) => {
        const accountId = xdr.LedgerKey.fromXDR(key, "base64").account().accountId();
        const account = accounts[StrKey.encodeEd25519PublicKey(accountId.ed25519())];
        if (!account) return [];
        return [{ key, xdr: accountData(accountId, account), lastModifiedLedgerSeq: 1 }];
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { entries, latestLedger: 100 } }));
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The account's `LedgerEntryData`, base64, as `getLedgerEntries` returns it. */
function accountData(accountId: xdr.PublicKey, account: StubAccount): string {
  const entry = new xdr.AccountEntry({
    accountId,
    balance: xdr.Int64.fromString("15000000"),
    seqNum: xdr.Int64.fromString("1"),
    numSubEntries: account.signers.length,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    // [master weight, low, medium, high]
    thresholds: Buffer.from([account.masterWeight, 0, 0, 0]),
    signers: account.signers.map(
      (s) =>
        new xdr.Signer({
          key: xdr.SignerKey.signerKeyTypeEd25519(Keypair.fromPublicKey(s.key).rawPublicKey()),
          weight: s.weight,
        }),
    ),
    ext: new xdr.AccountEntryExt(0),
  });
  return xdr.LedgerEntryData.account(entry).toXDR("base64");
}
