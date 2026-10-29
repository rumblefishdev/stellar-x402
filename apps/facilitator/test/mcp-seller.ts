import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PaymentRequired } from "@x402/core/types";
import { z } from "zod";

export interface McpSeller {
  /** The JSON-RPC messages it was sent, in order. */
  messages: { method: string; params?: Record<string, unknown> }[];
  /** `http://127.0.0.1:<port>/mcp`. */
  url: string;
  /** Event streams (`GET`) still open. */
  openStreams: () => number;
  server: Server;
}

const read = async (req: IncomingMessage) => {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return body;
};

/**
 * An MCP seller on this machine for the cataloger's check (0063 rows 5, 18): one tool, `weather`,
 * that takes a `city`. Unpaid, it answers as upstream's payment wrapper does (`@x402/mcp` 2.28.0
 * `createPaymentRequiredResult`): an error result whose `structuredContent` and first text are the
 * 402 terms; `free` answers as a free tool; `never` accepts the call and never sends its result. `tools` lists other names instead of `weather`;
 * `outputSchema` gives the tool one the terms don't match; `textOnly` leaves out
 * `structuredContent`, as some sellers do; `description` is each tool's.
 */
export async function startMcpSeller(
  answer: () => PaymentRequired | "free" | "never",
  {
    tools = ["weather"],
    outputSchema = false,
    textOnly = false,
    description = "",
  }: { tools?: string[]; outputSchema?: boolean; textOnly?: boolean; description?: string } = {},
): Promise<McpSeller> {
  const streams = new Set<IncomingMessage>();
  const seller: McpSeller = {
    messages: [],
    url: "",
    openStreams: () => streams.size,
    server: createServer((req, res) => {
      void (async () => {
        const body = req.method === "POST" ? JSON.parse(await read(req)) : undefined;
        for (const message of [body ?? []].flat()) seller.messages.push(message);
        if (req.method === "GET") {
          streams.add(req);
          req.on("close", () => streams.delete(req));
        }
        // Accepted, with the result promised on the event stream, where it never comes.
        if (body?.method === "tools/call" && answer() === "never") {
          res.writeHead(202).end();
          return;
        }
        // A server and a transport per request: the SDK's stateful mode keeps a session, which
        // the check does not need; GET still opens the server's event stream.
        const mcp = new McpServer({ name: "seller", version: "0.0.0" });
        for (const name of tools) {
          const schemas = outputSchema
            ? {
                description,
                inputSchema: { city: z.string() },
                outputSchema: { celsius: z.number() },
              }
            : { description, inputSchema: { city: z.string() } };
          mcp.registerTool(name, schemas, async () => {
            const terms = answer();
            if (terms === "free")
              return {
                content: [{ type: "text", text: "12 C" }],
                structuredContent: { celsius: 12 },
              };
            const text = { content: [{ type: "text" as const, text: JSON.stringify(terms) }] };
            if (textOnly) return { ...text, isError: true };
            return {
              structuredContent: terms as unknown as Record<string, unknown>,
              ...text,
              isError: true,
            };
          });
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        res.on("close", () => void transport.close());
        await transport.handleRequest(req, res, body);
      })();
    }),
  };
  seller.server.listen(0, "127.0.0.1");
  await once(seller.server, "listening");
  seller.url = `http://127.0.0.1:${(seller.server.address() as AddressInfo).port}/mcp`;
  return seller;
}
