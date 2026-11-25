import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadModel } from "./embed.js";
import { MODEL_ID } from "./model.js";

/**
 * The search model's HTTP server (ADR 0014): `POST /embed` with `{"text": "...", "kind": "query"}`
 * (`kind` is `"listing"` when left out) answers
 * `{"model", "vector"}`; `GET /health` answers 200 once the model is loaded. It reaches nothing
 * and holds no secret: the facilitator calls it over the environment's internal network.
 */
export async function startServer(options: { modelDir: string; port: number }) {
  const embed = await loadModel(options.modelDir);
  const server = createServer(async (request, response) => {
    const answer = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/health")
      return answer(200, { model: MODEL_ID });
    if (request.method !== "POST" || request.url !== "/embed")
      return answer(404, { error: "not_found" });
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return answer(400, { error: "body_not_json" });
    }
    const { text, kind = "listing" } = (body ?? {}) as { text?: unknown; kind?: unknown };
    if (typeof text !== "string") return answer(400, { error: "text_not_a_string" });
    if (kind !== "listing" && kind !== "query") return answer(400, { error: "unknown_kind" });
    try {
      answer(200, { model: MODEL_ID, vector: await embed(text, kind) });
    } catch (error) {
      console.error(JSON.stringify({ event: "embed_failed", error: String(error) }));
      answer(500, { error: "embed_failed" });
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
