import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fetch } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { boundedAgent } from "../src/adapters/http-timeouts.js";

async function listen(handle: Parameters<typeof createServer>[1]): Promise<[Server, string]> {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return [server, `http://127.0.0.1:${port}`];
}

describe("boundedAgent", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
  });

  it("ends a request to a listed origin at its own bound, and leaves the others the default", async () => {
    const [hung, hungUrl] = await listen(() => {});
    const [slow, slowUrl] = await listen((_req, res) => {
      setTimeout(() => res.end("ok"), 300);
    });
    servers.push(hung, slow);
    const agent = boundedAgent(5_000, { [hungUrl]: 100 });

    const started = Date.now();
    await expect(fetch(`${hungUrl}/ledgers`, { dispatcher: agent })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);

    // 300 ms, past the listed origin's 100 ms, inside the default 5 s.
    const answer = await fetch(`${slowUrl}/`, { dispatcher: agent });
    expect(await answer.text()).toBe("ok");
    await agent.close();
  });
});
