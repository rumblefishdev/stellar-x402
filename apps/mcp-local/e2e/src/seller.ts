import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

/** The project's example seller (`examples/http-api`), built, settled by the public x402.org facilitator. */
const EXAMPLE_SELLER = fileURLToPath(
  new URL("../../../../examples/http-api/dist/index.js", import.meta.url),
);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

export interface ExampleSeller {
  url: string;
  stop(): void;
}

/** Starts the example seller paying `payTo`, and waits until it listens. */
export async function startExampleSeller(payTo: string): Promise<ExampleSeller> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [EXAMPLE_SELLER], {
    env: { PATH: process.env.PATH!, SELLER_ADDRESS: payTo, PORT: String(port) },
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Paid weather API")) resolve();
    });
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => reject(new Error(`example seller exited ${code}: ${output}`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}
