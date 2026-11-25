import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The search model's HTTP server with the real model (0120 C). The model files come from
 * `MODEL_DIR`; without it every case here is skipped.
 */
const MODEL_DIR = process.env.MODEL_DIR;

const norm = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
const cosine = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i]!, 0);

describe.skipIf(MODEL_DIR === undefined)("search model server (0120 C, needs MODEL_DIR)", () => {
  let server: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    const { startServer } = await import("../src/server.js");
    server = await startServer({ modelDir: MODEL_DIR!, port: 0 });
  }, 60_000);
  afterAll(() => server?.close());

  const embed = (body: string) =>
    fetch(`${server.url}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  const vectorOf = async (text: string) => {
    const response = await embed(JSON.stringify({ text }));
    expect(response.status).toBe(200);
    return (await response.json()) as { model: string; vector: number[] };
  };

  it("reads a query only up to 256 tokens, a listing up to 512 (ADR 0014)", async () => {
    const long = "weather forecast for every city and hour ".repeat(60);
    const asQuery = await embed(JSON.stringify({ text: long, kind: "query" }));
    const asListing = await embed(JSON.stringify({ text: long }));
    const vectorIn = async (response: Response) =>
      ((await response.json()) as { vector: number[] }).vector;
    const [query, listing] = [await vectorIn(asQuery), await vectorIn(asListing)];
    expect(query).not.toEqual(listing);
    const short = "weather in Warsaw";
    const shortQuery = await embed(JSON.stringify({ text: short, kind: "query" }));
    expect(await vectorIn(shortQuery)).toEqual((await vectorOf(short)).vector);
  });

  it("answers its health check", async () => {
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it("answers a text's model and its vector of 384 numbers of unit length", async () => {
    const { model, vector } = await vectorOf("Weather forecast for a city");
    expect(typeof model).toBe("string");
    expect(model).not.toBe("");
    expect(vector).toHaveLength(384);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(Math.abs(norm(vector) - 1)).toBeLessThanOrEqual(1e-5);
  });

  it("gives the same text the same vector", async () => {
    const first = await vectorOf("Tide tables for the Baltic");
    const second = await vectorOf("Tide tables for the Baltic");
    expect(second).toEqual(first);
  });

  it("cuts a text at 2,000 characters before embedding it", async () => {
    const long = "weather forecast for every city in Poland, ".repeat(250);
    expect(long.length).toBeGreaterThan(2_000);
    const whole = await vectorOf(long);
    const cut = await vectorOf(long.slice(0, 2_000));
    expect(whole).toEqual(cut);
  });

  it("embeds a text of more than 512 tokens, cut to 512", async () => {
    // One token a word: 1,000 tokens in 2,000 characters.
    const { vector } = await vectorOf("a ".repeat(1_000));
    expect(vector).toHaveLength(384);
    expect(Math.abs(norm(vector) - 1)).toBeLessThanOrEqual(1e-5);
  });

  it("embeds an empty text", async () => {
    const { vector } = await vectorOf("");
    expect(vector).toHaveLength(384);
  });

  it("puts related texts closer than unrelated ones", async () => {
    const weather = (await vectorOf("Weather forecast for a city")).vector;
    const rain = (await vectorOf("Will it rain in Kraków tomorrow?")).vector;
    const stocks = (await vectorOf("Stock exchange closing prices")).vector;
    expect(cosine(weather, rain)).toBeGreaterThan(cosine(weather, stocks));
  });

  it.each([
    ["no text", "{}"],
    ["a text that is a number", JSON.stringify({ text: 42 })],
    ["a text that is null", JSON.stringify({ text: null })],
    ["a text that is a list", JSON.stringify({ text: ["weather"] })],
    ["a body that isn't JSON", "weather"],
    ["a kind it doesn't know", JSON.stringify({ text: "weather", kind: "tool" })],
  ])("answers 400 to %s", async (_name, body) => {
    expect((await embed(body)).status).toBe(400);
  });
});
