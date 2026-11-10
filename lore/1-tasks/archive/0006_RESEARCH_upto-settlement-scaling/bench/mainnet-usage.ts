// Samples recent mainnet ledgers: Soroban transaction count, envelope bytes and execution
// stages, to see how much of the per-ledger Soroban capacity other traffic already uses.
// Usage: node mainnet-usage.ts <ledgers> [RPC_URL]
import { Networks, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { writeFileSync } from "node:fs";

const n = Number(process.argv[2] ?? 60);
const url = process.argv[3] ?? "https://mainnet.sorobanrpc.com";
const server = new rpc.Server(url);
const latest = (await server.getLatestLedger()).sequence;
const rows = [];
let start = latest - n;
while (start < latest) {
  const res = await server.getLedgers({ startLedger: start, pagination: { limit: Math.min(20, latest - start) } });
  for (const l of res.ledgers) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated XDR object */
    const body: any = (l.metadataXdr as any).v2 ?? (l.metadataXdr as any).v1;
    let classic = 0;
    let soroban = 0;
    let sorobanBytes = 0;
    const stages: number[][] = [];
    for (const phase of (body.txSet.v1 ?? body.txSet.v1TxSet).phases) {
      if (phase.v0Components) {
        for (const c of phase.v0Components) classic += c.txsMaybeDiscountedFee.txs.length;
      } else {
        for (const stage of phase.parallelTxsComponent.executionStages) {
          stages.push(stage.map((cluster: xdr.TransactionEnvelope[]) => cluster.length));
          for (const cluster of stage)
            for (const e of cluster) {
              soroban++;
              sorobanBytes += TransactionBuilder.fromXDR(e, Networks.PUBLIC).toEnvelope().toXDR().length;
            }
        }
      }
    }
    rows.push({ ledger: l.sequence, classic, soroban, sorobanBytes, stages });
  }
  start += res.ledgers.length;
}
const avg = (k: "classic" | "soroban" | "sorobanBytes") => Math.round(rows.reduce((s, r) => s + r[k], 0) / rows.length);
const max = (k: "classic" | "soroban" | "sorobanBytes") => Math.max(...rows.map((r) => r[k]));
const fee = await server.getFeeStats();
const summary = {
  rpc: url,
  ledgers: [rows[0].ledger, rows.at(-1)!.ledger],
  sampled: rows.length,
  soroban: { avg: avg("soroban"), max: max("soroban") },
  sorobanBytes: { avg: avg("sorobanBytes"), max: max("sorobanBytes"), limit: 266240 },
  classic: { avg: avg("classic"), max: max("classic") },
  sorobanBytesP50: rows.map((r) => r.sorobanBytes).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  ledgersOver90PctBytes: rows.filter((r) => r.sorobanBytes > 0.9 * 266240).length,
  multiClusterLedgers: rows.filter((r) => r.stages.some((s) => s.length > 1) || r.stages.length > 1).length,
  sorobanInclusionFee: fee.sorobanInclusionFee,
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync("results/mainnet-usage.json", JSON.stringify({ ranAt: new Date().toISOString(), summary, rows }, null, 2) + "\n");
