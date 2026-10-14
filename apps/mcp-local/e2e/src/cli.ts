import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The built CLI, as an MCP client such as Claude Desktop starts it. */
export const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

/** Every tool answer and every server's stderr of the run, searched for the buyer's secret at the end. */
export const captured: string[] = [];

/**
 * A tool's answer: its text, the text parsed when it is JSON, and whether it is an error. A call the
 * SDK refuses (an unknown tool, input failing the schema) comes back as an error text too.
 */
export interface Answer {
  isError: boolean;
  text: string;
  value: (Record<string, unknown> & { error?: { code: string; message: string } }) | undefined;
}

/** The error code of a tool answer, or "ok" for a result. */
export function code(answer: Answer): string {
  return answer.value?.error?.code ?? (answer.isError ? `sdk: ${answer.text.slice(0, 60)}` : "ok");
}

export interface RunningServer {
  call(name: string, args: Record<string, unknown>): Promise<Answer>;
  tools(): Promise<{ name: string; annotations?: { destructiveHint?: boolean } }[]>;
  stderr(): string;
  close(): Promise<void>;
}

/**
 * Only the variables the scenario names reach the server, plus PATH and HOME: an unknown
 * `STELLAR_X402_` variable from the shell running the suite would stop the start.
 */
function serverEnv(env: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env };
}

/** Starts the CLI over stdio and connects an MCP client to it. */
export async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: serverEnv(env),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: "stellar-x402-e2e", version: "0.0.0" });
  await client.connect(transport);
  return {
    async call(name, args) {
      let isError: boolean;
      let text: string;
      try {
        const result = await client.callTool({ name, arguments: args });
        text = (result.content as { text: string }[])[0]!.text;
        isError = result.isError === true;
      } catch (error) {
        text = String(error);
        isError = true;
      }
      captured.push(text);
      let value: Answer["value"];
      try {
        value = JSON.parse(text) as Answer["value"];
      } catch {
        // Not JSON: the SDK's own error text, kept in `text`.
        value = undefined;
      }
      return { isError, text, value };
    },
    tools: async () => (await client.listTools()).tools,
    stderr: () => stderr,
    async close() {
      await client.close();
      captured.push(stderr);
    },
  };
}

/** Starts the CLI expecting it to refuse its settings: the exit code and stderr, within 10 s. */
export function failedStart(
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [CLI], { env: serverEnv(env) });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 10_000);
  return new Promise((resolve) =>
    child.on("exit", (code) => {
      clearTimeout(timer);
      captured.push(stderr);
      resolve({ code, stderr });
    }),
  );
}
