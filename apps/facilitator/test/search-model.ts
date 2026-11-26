import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../../search-model/dist/main.js", import.meta.url));
const FETCH = fileURLToPath(new URL("../../search-model/scripts/fetch-model.mjs", import.meta.url));
/** The model's files, 121 MB, downloaded by the first run into a directory git ignores. */
const MODEL_DIR = fileURLToPath(
  new URL("../../../node_modules/.cache/search-model", import.meta.url),
);

/**
 * Starts the search model (ADR 0014) from its build, for the runs that start a whole facilitator
 * on testnet: the MCP e2e and the live scripts. `pnpm --filter @stellar-x402/search-model build`
 * first. Its log goes to stderr, so a model that can't start shows why.
 */
export async function startSearchModel(): Promise<{ url: string; stop: () => Promise<void> }> {
  // fetch-model writes each file only once it is whole, and the tokenizer's config last.
  if (!existsSync(`${MODEL_DIR}/tokenizer_config.json`)) {
    const fetching = spawn(process.execPath, [FETCH, MODEL_DIR], { stdio: "inherit" });
    const [code] = await once(fetching, "exit");
    if (code !== 0) throw new Error(`fetching the search model's files exited ${code}`);
  }
  const child = spawn(process.execPath, [SERVER], {
    // As the image sets them (apps/facilitator/Dockerfile).
    env: { MODEL_DIR, PORT: "0", ORT_DISABLE_TELEMETRY: "1" },
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const read = (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString();
      const listening = /"event":"search_model_listening","port":(\d+)/.exec(output);
      if (listening) resolve(`http://127.0.0.1:${listening[1]}`);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", (code) => reject(new Error(`the search model exited ${code}: ${output}`)));
  });
  return {
    url,
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await once(child, "exit");
      }
    },
  };
}
