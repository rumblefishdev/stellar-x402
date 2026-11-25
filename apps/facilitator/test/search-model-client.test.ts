import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createSearchModelClient } from "../src/adapters/search-model.js";
import { parseConfig } from "../src/config.js";
import { signerEnv } from "./fake-openbao.js";
import { unitVector } from "./vectors.js";

/** A stand-in for the search model container: answers each request with `answer`. */
async function stub(
  answer: (request: IncomingMessage, body: string, response: ServerResponse) => void,
) {
  const requests: { method?: string; url?: string; type?: string; body: string }[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        type: request.headers["content-type"],
        body,
      });
      answer(request, body, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  return { url, requests };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const VECTOR = unitVector(0.8);

describe("search model client (0120 D)", () => {
  it("posts the text to /embed and resolves the model and the vector", async () => {
    const model = await stub((_request, _body, response) =>
      json(response, 200, { model: "granite-test", vector: VECTOR }),
    );
    const client = createSearchModelClient({ url: model.url, timeoutMs: 2_000 });
    await expect(client.embed("weather in Kraków", "query")).resolves.toEqual({
      model: "granite-test",
      vector: VECTOR,
    });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({ method: "POST", url: "/embed" });
    expect(model.requests[0]!.type).toMatch(/^application\/json/);
    expect(JSON.parse(model.requests[0]!.body)).toEqual({
      text: "weather in Kraków",
      kind: "query",
    });
  });

  it("rejects when the container does not answer within the timeout, without waiting for it", async () => {
    const model = await stub((_request, _body, response) => {
      setTimeout(() => json(response, 200, { model: "granite-test", vector: VECTOR }), 1_500);
    });
    const client = createSearchModelClient({ url: model.url, timeoutMs: 100 });
    const started = Date.now();
    await expect(client.embed("weather", "listing")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("rejects a container that holds the answer's body past the timeout", async () => {
    const model = await stub((_request, _body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"model":"granite-test","vector":[');
      // The rest never comes.
    });
    const client = createSearchModelClient({ url: model.url, timeoutMs: 100 });
    const started = Date.now();
    await expect(client.embed("weather", "listing")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each([
    [500, { error: "internal" }],
    [503, { error: "loading" }],
    [400, { error: "bad_request" }],
    [404, {}],
  ])("rejects an answer of %i", async (status, body) => {
    const model = await stub((_request, _body, response) => json(response, status, body));
    const client = createSearchModelClient({ url: model.url, timeoutMs: 2_000 });
    await expect(client.embed("weather", "listing")).rejects.toThrow();
  });

  it("rejects when no container listens", async () => {
    const model = await stub(() => {});
    const url = model.url;
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    const client = createSearchModelClient({ url, timeoutMs: 2_000 });
    await expect(client.embed("weather", "listing")).rejects.toThrow();
  });

  // Not in point D's text; "errors are always loud": a 200 that isn't the contract's answer is a
  // failure, not a vector.
  it.each([
    ["a body that isn't JSON", "not json"],
    ["no vector", JSON.stringify({ model: "granite-test" })],
    ["no model", JSON.stringify({ vector: VECTOR })],
    ["a vector of 3 numbers", JSON.stringify({ model: "granite-test", vector: [1, 0, 0] })],
    [
      "a vector with a non-number",
      JSON.stringify({ model: "granite-test", vector: [...VECTOR.slice(1), "x"] }),
    ],
  ])("rejects a 200 with %s", async (_name, body) => {
    const model = await stub((_request, _body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    const client = createSearchModelClient({ url: model.url, timeoutMs: 2_000 });
    await expect(client.embed("weather", "listing")).rejects.toThrow();
  });
});

// The env names are this test's reading of "2,000 ms in config"; point D names only the value.
describe("search model config (0120 D)", () => {
  const minimal = {
    ...signerEnv(Keypair.random().publicKey()),
    CHANNELS: Keypair.random().publicKey(),
    CLIENT_IP: "socket",
    DATABASE_URL: "postgres://db.internal/x402",
  };

  it("refuses an environment without the search model's URL", () => {
    expect(() => parseConfig(minimal)).toThrow(/SEARCH_MODEL_URL/);
  });

  it("waits 2,000 ms for the search model by default", () => {
    const config = parseConfig({ ...minimal, SEARCH_MODEL_URL: "http://search-model:8080" });
    expect(config).toMatchObject({
      searchModel: { url: "http://search-model:8080", timeoutMs: 2_000 },
    });
  });
});
