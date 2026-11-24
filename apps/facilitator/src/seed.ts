import { ConfigError } from "./config.js";
import { jsonLogger } from "./logger.js";
import { SeedError, seedMain } from "./main.js";

// The `pnpm seed <hosts file>` entry point: the operator seeds the catalog once from the sellers'
// own files (0155). The report goes to stdout, every failure to stderr.
seedMain(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof SeedError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    // A ConfigError names each bad setting and never echoes a value.
    const fields = error instanceof ConfigError ? { problems: error.problems } : { error };
    jsonLogger("error", (line) => process.stderr.write(line)).error("seed_failed", fields);
  }
  process.exitCode = 1;
});
