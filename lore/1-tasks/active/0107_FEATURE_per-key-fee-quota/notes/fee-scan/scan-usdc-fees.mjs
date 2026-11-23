// Read-only scan: recent pubnet USDC SAC `transfer` transactions and the fees they were charged.
// Usage: node scan-usdc-fees.mjs <rpcUrl> <ledgersBack> <maxTx> <outJson>
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(
  new URL("../../../../../../apps/facilitator/package.json", import.meta.url),
);
const sdk = require("@stellar/stellar-sdk");
const { xdr, Address, Asset, Networks, scValToNative } = sdk;

const [rpcUrl, ledgersBackArg, maxTxArg, outPath] = process.argv.slice(2);
const ledgersBack = Number(ledgersBackArg ?? 1000);
const maxTx = Number(maxTxArg ?? 200);
const USDC = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
const usdcId = USDC.contractId(Networks.PUBLIC);

let id = 0;
async function call(method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => ({ ok: false, error: e }));
    if (res.ok) {
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`${method} failed`);
}

const latest = (await call("getLatestLedger", {})).sequence;
const startLedger = latest - ledgersBack;
const transferSym = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
const hashes = new Set();
let cursor;
for (let page = 0; page < 30 && hashes.size < 20000; page++) {
  const params = {
    filters: [{ type: "contract", contractIds: [usdcId], topics: [[transferSym, "*", "*", "*"]] }],
    pagination: { limit: 1000, ...(cursor && { cursor }) },
    ...(!cursor && { startLedger }),
  };
  const r = await call("getEvents", params);
  for (const e of r.events) hashes.add(e.txHash);
  if (r.events.length === 0 || !r.cursor) break;
  cursor = r.cursor;
}

const kind = (addr) => (addr.startsWith("G") ? "G" : addr.startsWith("C") ? "C" : addr[0]);
function sorobanFees(meta) {
  const sw = meta.switch();
  const sm = sw === 4 ? meta.v4().sorobanMeta() : sw === 3 ? meta.v3().sorobanMeta() : null;
  if (!sm) return {};
  const ext = sm.ext();
  if (ext.switch() !== 1) return {};
  const v1 = ext.v1();
  return {
    nonRefundable: Number(v1.totalNonRefundableResourceFeeCharged().toString()),
    refundable: Number(v1.totalRefundableResourceFeeCharged().toString()),
    rent: Number(v1.rentFeeCharged().toString()),
  };
}

const rows = [];
let scanned = 0;
async function one(hash) {
  let t;
  try {
    t = await call("getTransaction", { hash });
  } catch {
    return;
  }
  scanned++;
  if (t.status !== "SUCCESS" && t.status !== "FAILED") return;
  const env = xdr.TransactionEnvelope.fromXDR(t.envelopeXdr, "base64");
  const isBump = env.switch().name === "envelopeTypeTxFeeBump";
  const tx = isBump ? env.feeBump().tx().innerTx().v1().tx() : env.v1().tx();
  const ops = tx.operations();
  if (ops.length !== 1 || ops[0].body().switch().name !== "invokeHostFunction") return;
  const ihf = ops[0].body().invokeHostFunctionOp();
  const hf = ihf.hostFunction();
  if (hf.switch().name !== "hostFunctionTypeInvokeContract") return;
  const ic = hf.invokeContract();
  if (Address.fromScAddress(ic.contractAddress()).toString() !== usdcId) return;
  if (ic.functionName().toString() !== "transfer") return;
  const [from, to] = ic.args().slice(0, 2).map((a) => Address.fromScVal(a).toString());
  const authEntries = ihf.auth();
  const auth = authEntries.map((a) => a.credentials().switch().name.replace("sorobanCredentials", ""));
  let sigTtl = null;
  for (const a of authEntries) {
    if (a.credentials().switch().name === "sorobanCredentialsAddress") {
      sigTtl = a.credentials().address().signatureExpirationLedger() - t.ledger;
    }
  }
  const sd = tx.ext().switch() === 1 ? tx.ext().sorobanData() : null;
  const declaredResourceFee = sd ? Number(sd.resourceFee().toString()) : null;
  const res = sd?.resources();
  const result = xdr.TransactionResult.fromXDR(t.resultXdr, "base64");
  const meta = xdr.TransactionMeta.fromXDR(t.resultMetaXdr, "base64");
  const feeSource = isBump
    ? sdk.StrKey.encodeEd25519PublicKey(env.feeBump().tx().feeSource().switch().name === "keyTypeEd25519" ? env.feeBump().tx().feeSource().ed25519() : env.feeBump().tx().feeSource().med25519().ed25519()).slice(0, 6)
    : null;
  rows.push({
    hash,
    ledger: t.ledger,
    closedAt: new Date(Number(t.createdAt) * 1000).toISOString(),
    status: t.status,
    feeBump: isBump,
    feeSource,
    from: kind(from),
    to: kind(to),
    auth: auth.join("+") || "none",
    sigTtl,
    maxFee: isBump ? Number(env.feeBump().tx().fee().toString()) : Number(tx.fee()),
    declaredResourceFee,
    feeCharged: Number(result.feeCharged().toString()),
    ...sorobanFees(meta),
    instructions: res ? res.instructions() : null,
    readWrite: res ? res.footprint().readWrite().length : null,
  });
}
const list = [...hashes];
const CONC = 6;
for (let i = 0; i < list.length && rows.length < maxTx; i += CONC) {
  await Promise.all(list.slice(i, i + CONC).map(one));
}
writeFileSync(
  outPath,
  JSON.stringify({ rpcUrl, usdcId, latest, startLedger, eventTxs: hashes.size, scanned, rows }, null, 1),
);
console.log(`latest ${latest} start ${startLedger} txs with events ${hashes.size}, scanned ${scanned}, transfer rows ${rows.length}`);
