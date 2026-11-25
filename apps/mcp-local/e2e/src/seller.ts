import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The project's example seller (`examples/http-api`), built. */
const EXAMPLE_SELLER = fileURLToPath(
  new URL("../../../../examples/http-api/dist/index.js", import.meta.url),
);

export interface ExampleSeller {
  url: string;
  stop(): void;
}

/**
 * Starts the example seller paying `payTo` through `facilitatorUrl` on a port the system picks, and
 * waits until it names that port.
 */
export async function startExampleSeller(
  payTo: string,
  facilitatorUrl: string,
): Promise<ExampleSeller> {
  const child: ChildProcess = spawn(process.execPath, [EXAMPLE_SELLER], {
    env: {
      PATH: process.env.PATH!,
      SELLER_ADDRESS: payTo,
      PORT: "0",
      FACILITATOR_URL: facilitatorUrl,
    },
  });
  const port = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      // The slash after the number: stdout can arrive cut mid-number.
      const listening = /Paid weather API on http:\/\/localhost:(\d+)\//.exec(output);
      if (listening) resolve(listening[1]!);
    });
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => reject(new Error(`example seller exited ${code}: ${output}`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}
