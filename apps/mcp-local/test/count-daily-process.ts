import { countDaily } from "../src/daily.js";

/**
 * One buyer process trying five times to count one atomic unit, against a daily limit of 50, in the
 * state directory, day, payer and asset given as its arguments. Prints how many it counted; an error
 * exits 1.
 */
const [dir, day, payer, asset] = process.argv.slice(2);
const entry = { day: day!, payer: payer!, asset: asset! };
let counted = 0;
for (let i = 0; i < 5; i++) if (countDaily(dir!, entry, 1n, 50n)) counted++;
process.stdout.write(String(counted));
