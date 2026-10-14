import { countDaily } from "../src/daily.js";

/**
 * One buyer process trying five times to count one atomic unit, against a daily limit of 50, in the
 * state directory named by its first argument. Prints how many it counted; an error exits 1.
 */
const [dir] = process.argv.slice(2);
const entry = { day: "2026-10-13", payer: "GBUYER", asset: "CASSET" };
let counted = 0;
for (let i = 0; i < 5; i++) if (countDaily(dir!, entry, 1n, 50n)) counted++;
process.stdout.write(String(counted));
