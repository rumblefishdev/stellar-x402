import { countDaily } from "../src/daily.js";

/**
 * One buyer process counting one atomic unit against the daily record named by its first argument.
 * Exits 0 once counted; any refusal or error exits 1, so the parent test sees which process failed.
 */
const [file] = process.argv.slice(2);
const entry = { day: "2026-10-13", payer: "GBUYER", asset: "CASSET" };
const counted = await countDaily(file!, entry, 1n, 1_000n, (message) => console.error(message));
process.exit(counted ? 0 : 1);
