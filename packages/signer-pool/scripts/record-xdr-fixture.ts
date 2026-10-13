// Records the protocol-29 XDR fixture that test/xdr-fixture.test.ts parses (task 0016, AD-14):
// one settlement transaction with AddressV2 credentials inside a fee bump, and the
// LedgerCloseMeta of the ledger that applied it. Run it again only to replace the fixture; the
// test reads the files, never the network.
//
// The default transaction is a 0007 smoke-run settlement on testnet (2026-10-06): a channel as
// transaction source, the facilitator as operation source and fee-bump payer, the client's
// AddressV2 entry. Testnet RPC keeps about 7 days of history (`ledgerRetentionWindow`).
//
// Env: [RPC_URL] (default https://soroban-testnet.stellar.org)
// Usage: tsx scripts/record-xdr-fixture.ts [<transaction hash>]
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const DEFAULT_HASH = "b597301aceaceb406760fbc54dbcf25007bbb0083af5b71afe0b5a42f7647052";
const OUT = new URL("../test/fixtures/protocol-29/", import.meta.url);

async function call<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (!body.result) throw new Error(`${method}: ${body.error?.message ?? res.status}`);
  return body.result;
}

const hash = process.argv[2] ?? DEFAULT_HASH;
const tx = await call<{
  status: string;
  ledger: number;
  envelopeXdr: string;
  resultXdr: string;
  resultMetaXdr: string;
}>("getTransaction", { hash, xdrFormat: "base64" });
if (tx.status !== "SUCCESS") throw new Error(`transaction ${hash} is ${tx.status}`);

const { ledgers } = await call<{ ledgers: { sequence: number; metadataXdr: string }[] }>(
  "getLedgers",
  { startLedger: tx.ledger, pagination: { limit: 1 }, xdrFormat: "base64" },
);
const ledger = ledgers[0];
if (ledger?.sequence !== tx.ledger) throw new Error(`ledger ${tx.ledger} not returned`);

mkdirSync(OUT, { recursive: true });
const transaction = {
  network: "testnet",
  rpc: RPC_URL,
  recordedAt: new Date().toISOString(),
  hash,
  ledger: tx.ledger,
  envelopeXdr: tx.envelopeXdr,
  resultXdr: tx.resultXdr,
  resultMetaXdr: tx.resultMetaXdr,
};
writeFileSync(new URL("transaction.json", OUT), `${JSON.stringify(transaction, null, 2)}\n`);
// About 165 KB raw for a 24-transaction ledger; gzip keeps the repo copy near 22 KB.
writeFileSync(
  new URL("ledger-close-meta.xdr.gz", OUT),
  gzipSync(Buffer.from(ledger.metadataXdr, "base64"), { level: 9 }),
);
console.log(`recorded ${hash} and ledger ${tx.ledger} into ${OUT.pathname}`);
