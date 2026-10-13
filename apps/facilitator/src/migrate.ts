import { ConfigError } from "./config.js";
import { jsonLogger } from "./logger.js";
import { migrateMain } from "./main.js";

// The `pnpm migrate` entry point, run before a deploy starts the service.
migrateMain().catch((error: unknown) => {
  // A ConfigError names each bad setting and never echoes a value.
  const fields = error instanceof ConfigError ? { problems: error.problems } : { error };
  jsonLogger("error").error("migrate_failed", fields);
  process.exitCode = 1;
});
