// Read-only: pubnet's live Soroban state size window and the ledger cost settings.
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../../../../apps/facilitator/package.json", import.meta.url));
const { xdr } = require("@stellar/stellar-sdk");
const rpcUrl = process.argv[2];
const ids = (process.argv[3] ?? "").split(",");
const keys = ids.map((n) => xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId[n]() })).toXDR("base64"));
const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLedgerEntries", params: { keys } }) }).then((r) => r.json());
console.log("latestLedger", res.result.latestLedger);
for (const e of res.result.entries) {
  const cs = xdr.LedgerEntryData.fromXDR(e.xdr, "base64").configSetting();
  const name = cs.switch().name;
  const v = cs.value();
  if (Array.isArray(v)) {
    const nums = v.map((x) => Number(x.toString()));
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    console.log(name, "n", nums.length, "first", nums[0], "last", nums.at(-1), "avg", Math.round(avg));
  } else {
    const o = {};
    for (const k of Object.keys(v._attributes ?? {})) o[k] = v._attributes[k]?.toString?.() ?? v._attributes[k];
    console.log(name, JSON.stringify(o));
  }
}
