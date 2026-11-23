// Read-only: a fee account's recent transactions on Horizon, classified, with fee_charged.
// Usage: node horizon-fee-account.mjs <G…> <pages> <out.json>
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../../../../../../apps/facilitator/package.json", import.meta.url));
const { xdr, Address } = require("@stellar/stellar-sdk");
const [account, pagesArg, out] = process.argv.slice(2);
const kind = (a) => a[0];
let url = `https://horizon.stellar.org/accounts/${account}/transactions?order=desc&limit=200&include_failed=true`;
const rows = [];
for (let p = 0; p < Number(pagesArg); p++) {
  const d = await fetch(url, { signal: AbortSignal.timeout(30000) }).then((r) => r.json());
  const recs = d._embedded?.records ?? [];
  for (const t of recs) {
    const env = xdr.TransactionEnvelope.fromXDR(t.envelope_xdr, "base64");
    const bump = env.switch().name === "envelopeTypeTxFeeBump";
    const tx = bump ? env.feeBump().tx().innerTx().v1().tx() : env.switch().name === "envelopeTypeTx" ? env.v1().tx() : null;
    const base = { hash: t.hash, at: t.created_at, ok: t.successful, feeAccount: (t.fee_account ?? "").slice(0, 6), bump, feeCharged: Number(t.fee_charged), maxFee: Number(t.max_fee) };
    if (!tx || tx.operations().length !== 1 || tx.operations()[0].body().switch().name !== "invokeHostFunction") { rows.push({ ...base, shape: "other" }); continue; }
    const ihf = tx.operations()[0].body().invokeHostFunctionOp();
    const hf = ihf.hostFunction();
    if (hf.switch().name !== "hostFunctionTypeInvokeContract") { rows.push({ ...base, shape: "other-hf" }); continue; }
    const ic = hf.invokeContract();
    const contract = Address.fromScAddress(ic.contractAddress()).toString();
    const fn = ic.functionName().toString();
    let from = "?", to = "?";
    if (fn === "transfer") [from, to] = ic.args().slice(0, 2).map((a) => kind(Address.fromScVal(a).toString()));
    const auth = ihf.auth().map((a) => a.credentials().switch().name.replace("sorobanCredentials", "")).join("+");
    const sd = tx.ext().switch() === 1 ? tx.ext().sorobanData() : null;
    rows.push({ ...base, shape: `${contract.slice(0, 6)}.${fn}`, from, to, auth, declaredResourceFee: sd ? Number(sd.resourceFee().toString()) : null, instructions: sd ? sd.resources().instructions() : null });
  }
  url = d._links?.next?.href;
  if (!url || recs.length === 0) break;
}
writeFileSync(out, JSON.stringify(rows, null, 1));
const groups = {};
for (const r of rows) {
  const k = `${r.shape} ${r.from ?? ""}->${r.to ?? ""} ${r.auth ?? ""} ok=${r.ok}`;
  (groups[k] ??= []).push(r.feeCharged);
}
const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
  v.sort((a, b) => a - b);
  console.log(`${k}  n=${v.length} min=${v[0]} p50=${pct(v, 0.5)} p90=${pct(v, 0.9)} max=${v.at(-1)} mean=${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}`);
}
console.log("from", rows.at(-1)?.at, "to", rows[0]?.at, "rows", rows.length);
