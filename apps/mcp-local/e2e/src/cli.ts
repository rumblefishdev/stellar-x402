import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The built CLI, as an MCP client such as Claude Desktop starts it. */
export const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

/**
 * Everything the run's servers wrote: every tool result whole (text, structured content, any other
 * block), every stderr chunk as it arrives, and the stdout of failed starts. E-23 searches it for the
 * buyer's secret. Collected as it arrives, so a scenario that throws midway is still covered.
 */
export const captured: string[] = [];

/** Servers started and not yet closed; the suite closes the rest after a failed scenario. */
export const running = new Set<RunningServer>();
/** How many processes the run started: E-23 checks each one left something in `captured`. */
export const started = { count: 0 };

/**
 * A tool's answer: its text, the text parsed when it is JSON, and whether it is an error. A call the
 * SDK refuses (an unknown tool, input failing the schema) comes back as an error text too.
 */
export interface Answer {
  isError: boolean;
  text: string;
  value: (Record<string, unknown> & { error?: { code: string; message: string } }) | undefined;
}

/** What `call_paid_http` returns when it paid. */
export interface PaidResult {
  status: number;
  contentType: string | null;
  body: string;
  payment: { network: string; amount: string; asset: string; transaction: string | null };
}

/** The error code of a tool answer, "ok" for a JSON result, and the text otherwise. */
export function code(answer: Answer): string {
  if (answer.value?.error) return answer.value.error.code;
  if (answer.value) return answer.isError ? `error without a code: ${answer.text}` : "ok";
  return `${answer.isError ? "sdk error" : "not json"}: ${answer.text.slice(0, 60)}`;
}

export interface RunningServer {
  call(name: string, args: Record<string, unknown>): Promise<Answer>;
  tools(): Promise<
    { name: string; outputSchema?: unknown; annotations?: { destructiveHint?: boolean } }[]
  >;
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
  started.count++;
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    captured.push(chunk.toString());
  });
  const client = new Client({ name: "stellar-x402-e2e", version: "0.0.0" });
  await client.connect(transport);
  // As Claude Desktop does: listing the tools makes the SDK check every result against its tool's
  // output schema.
  await client.listTools();
  const server: RunningServer = {
    async call(name, args) {
      let isError: boolean;
      let text: string;
      try {
        const result = await client.callTool({ name, arguments: args });
        captured.push(JSON.stringify(result));
        text = (result.content as { text: string }[])[0]!.text;
        isError = result.isError === true;
      } catch (error) {
        text = String(error);
        captured.push(text);
        isError = true;
      }
      let value: Answer["value"];
      try {
        value = JSON.parse(text) as Answer["value"];
      } catch {
        // Not JSON: the SDK's own error text, kept in `text` and reported by `code`.
        value = undefined;
      }
      return { isError, text, value };
    },
    tools: async () => (await client.listTools()).tools,
    stderr: () => stderr,
    async close() {
      running.delete(server);
      await client.close();
    },
  };
  running.add(server);
  return server;
}

/** Starts the CLI expecting it to refuse its settings: the exit code and stderr, within 10 s. */
export function failedStart(
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [CLI], { env: serverEnv(env) });
  started.count++;
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => captured.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    captured.push(chunk.toString());
  });
  // A server that does not stop is killed, and the null exit code says so.
  const timer = setTimeout(() => child.kill(), 10_000);
  return new Promise((resolve) =>
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    }),
  );
}
