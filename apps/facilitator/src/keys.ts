import { ConfigError } from "./config.js";
import { jsonLogger } from "./logger.js";
import { KeysError, keysMain } from "./main.js";

// The `pnpm keys` entry point: the operator issues, revokes and lists API keys by hand (0105).
// What it prints for the operator goes to stdout, a new key included, and every failure to stderr.
keysMain(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof KeysError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    // A ConfigError names each bad setting and never echoes a value.
    const fields = error instanceof ConfigError ? { problems: error.problems } : { error };
    jsonLogger("error", (line) => process.stderr.write(line)).error("keys_failed", fields);
  }
  process.exitCode = 1;
});
