import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchVectors } from "../src/catalog/search-vectors.js";
import { jsonLogger } from "../src/logger.js";
import { main } from "../src/main.js";
import { memoryMetrics } from "../src/metrics.js";
import type { CatalogKey } from "../src/ports/index.js";
import type { Embedder } from "../src/ports/embedder.js";
import { testDatabase } from "./database.js";
import { signerEnv } from "./fake-openbao.js";
import { hardened, rpcStub } from "./rpc-stub.js";
import { meaningText, readCards, sameVector, setVector, sha256, unitVector } from "./vectors.js";

// Every case here needs the `vector` extension (pgvector) in the test database.

// `main()`'s EMF lines off stdout: `LOG_LEVEL` quiets the logger only.
vi.mock("../src/adapters/emf-metrics.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/adapters/emf-metrics.js")>();
  return {
    ...actual,
    emfMetrics: (opts: Parameters<typeof actual.emfMetrics>[0]) =>
      actual.emfMetrics({ write: () => {}, ...opts }),
  };
});

const MODEL = "granite-test";

/** A vector of its own for each text, so a stored vector names the text it was made from. */
function vectorFor(text: string): number[] {
  const byte = Buffer.from(sha256(text), "hex")[0]!;
  return unitVector(0.5 + (byte / 255) * 0.45);
}

/**
 * An embedder that records each text, tracks how many calls run at once, fails a text `fail`
 * names, and waits on `hold` when one is set.
 */
function fakeEmbedder(fail: (text: string) => boolean = () => false) {
  const state = {
    calls: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    hold: undefined as Promise<void> | undefined,
    started: undefined as (() => void) | undefined,
  };
  const embedder: Embedder = {
    embed: async (text) => {
      state.calls.push(text);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        state.started?.();
        if (state.hold) await state.hold;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (fail(text)) throw new Error(`model failed on ${text.slice(0, 20)}`);
        return { model: MODEL, vector: vectorFor(text) };
      } finally {
        state.inFlight--;
      }
    },
  };
  return { embedder, state };
}

const db = testDatabase();

const key = (host: string): CatalogKey => ({
  network: "stellar:testnet",
  payTo: "GPAYTO",
  method: "GET",
  resourceUrl: `https://${host}.example/x`,
});

const list = (host: string, fields: Partial<DiscoveryResource>, checkedAt = 1) =>
  db.stores().catalog.upsert({
    keyVersion: CATALOG_KEY_VERSION,
    ledger: null,
    checkedAt,
    key: key(host),
    resource: {
      resource: key(host).resourceUrl,
      type: "http",
      x402Version: 2,
      accepts: [],
      lastUpdated: "2026-11-24T00:00:00.000Z",
      ...fields,
    },
  });

function vectors(embedder: Embedder, lines: string[] = [], metrics = memoryMetrics()) {
  return createSearchVectors({
    store: db.stores().searchCards,
    embedder,
    logger: jsonLogger("debug", (line) => lines.push(line)),
    metrics,
  });
}

const parsed = (lines: string[]) => lines.map((line) => JSON.parse(line));

/** A card holds a current vector: of the model, of its text as it is now, from that text. */
const current = (card: Awaited<ReturnType<typeof readCards>>[number]) =>
  card.model === MODEL &&
  card.text_hash === sha256(meaningText(card)) &&
  sameVector(card.embedding, vectorFor(meaningText(card)));

describe("the vector pass at start (0120 F)", () => {
  beforeEach(() => db.empty());

  it("embeds every card whose vector is missing or stale, and no current one (F, B)", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    await list("three", { description: "Stocks three" });
    await list("four", { description: "Bonds four" });
    // two: a vector of another model; three: of another text; four: current.
    await setVector(db.pool, key("two"), "old-model", unitVector(0.9));
    await setVector(db.pool, key("three"), MODEL, unitVector(0.9));
    await db.pool.query(
      `UPDATE catalog_search s SET text_hash = 'stale' FROM catalog c
        WHERE c.seq = s.seq AND c.resource_url = $1`,
      [key("three").resourceUrl],
    );
    await setVector(db.pool, key("four"), MODEL, unitVector(0.7));
    const { embedder, state } = fakeEmbedder();
    await vectors(embedder).start();
    const cards = await readCards(db.pool);
    expect(state.calls).toEqual(cards.slice(0, 3).map(meaningText));
    expect(cards.slice(0, 3).every(current)).toBe(true);
    // The current one keeps its vector.
    expect(sameVector(cards[3]!.embedding, unitVector(0.7))).toBe(true);
  });

  it("embeds a card's fields joined with a line break, empty ones skipped, hashed with SHA-256 (B)", async () => {
    await list("rich", {
      serviceName: "Weather",
      tags: ["forecast", "rain"],
      description: "City forecasts",
      extensions: {
        bazaar: { info: { input: { type: "http", queryParams: { city: "Gdańsk" } } } },
      },
    });
    await list("plain", { description: "Tides" });
    const { embedder, state } = fakeEmbedder();
    await vectors(embedder).start();
    const [rich, plain] = await readCards(db.pool);
    expect(state.calls[0]).toBe(
      [rich!.name, rich!.tags, rich!.description, rich!.parameters].join("\n"),
    );
    // No tags and no parameters: nothing of them, not even their line breaks.
    expect([plain!.tags, plain!.parameters]).toEqual(["", ""]);
    expect(state.calls[1]).toBe(`${plain!.name}\n${plain!.description}`);
    expect(rich!.text_hash).toBe(sha256(state.calls[0]!));
    expect(plain!.text_hash).toBe(sha256(state.calls[1]!));
    expect(rich!.text_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cuts the text at 2,000 characters before embedding and hashing it (B)", async () => {
    await list("long", { description: "lorem ipsum ".repeat(400) });
    const { embedder, state } = fakeEmbedder();
    await vectors(embedder).start();
    const [card] = await readCards(db.pool);
    const whole = [card!.name, card!.tags, card!.description, card!.parameters]
      .filter((field) => field !== "")
      .join("\n");
    expect(whole.length).toBeGreaterThan(2_000);
    expect(state.calls).toEqual([whole.slice(0, 2_000)]);
    expect(card!.text_hash).toBe(sha256(whole.slice(0, 2_000)));
  });

  it("asks the model for one listing at a time (F)", async () => {
    for (const host of ["a", "b", "c", "d", "e"]) await list(host, { description: host });
    const { embedder, state } = fakeEmbedder();
    await vectors(embedder).start();
    expect(state.calls).toHaveLength(5);
    expect(state.maxInFlight).toBe(1);
  });

  it("logs and counts a listing the model fails on, goes on, and does not try it again (F, E)", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    await list("three", { description: "Stocks three" });
    const { embedder, state } = fakeEmbedder((text) => text.includes("two"));
    const lines: string[] = [];
    const metrics = memoryMetrics();
    await vectors(embedder, lines, metrics).start();
    const [one, two, three] = await readCards(db.pool);
    expect([current(one!), current(three!)]).toEqual([true, true]);
    expect([two!.model, two!.text_hash, two!.embedding]).toEqual([null, null, null]);
    expect(metrics.value("search_vector_failures_total")).toBe(1);
    expect(parsed(lines)).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "search_vector_failed",
        error: expect.objectContaining({ message: expect.stringContaining("model failed") }),
      }),
    );
    // No retry loop: the failed listing waits for the next pass.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(state.calls.filter((text) => text.includes("two"))).toHaveLength(1);
    expect(state.calls).toHaveLength(3);
  });

  it("stops between listings once closed, and close waits for the one under way (F)", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    const { embedder, state } = fakeEmbedder();
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    const underWay = new Promise<void>((resolve) => (state.started = resolve));
    const job = vectors(embedder);
    void job.start();
    await underWay;
    const closing = job.close();
    release();
    await closing;
    expect(state.calls).toHaveLength(1);
    const cards = await readCards(db.pool);
    expect(cards.filter((card) => card.embedding !== null)).toHaveLength(1);
  });

  it("writes no vector over a listing whose text changed while it was embedded (F, ADR 0014)", async () => {
    await list("one", { description: "Weather" });
    const [before] = await readCards(db.pool);
    const old = meaningText(before!);
    const { embedder, state } = fakeEmbedder();
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    const underWay = new Promise<void>((resolve) => (state.started = resolve));
    const pass = vectors(embedder).start();
    await underWay;
    // The catalog writes the listing again, with its card, while the model works.
    state.hold = undefined;
    await list("one", { description: "Tides" }, 2);
    release();
    await pass;
    const [after] = await readCards(db.pool);
    expect(after!.text_hash).not.toBe(sha256(old));
    expect(sameVector(after!.embedding, vectorFor(old))).toBe(false);
  });
});

describe("a listing's vector after the catalog writes it (0120 E)", () => {
  beforeEach(() => db.empty());

  it("computes and stores the vector of the listing written", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    const { embedder, state } = fakeEmbedder();
    await vectors(embedder).listed(key("one"));
    const [one, two] = await readCards(db.pool);
    expect(state.calls).toEqual([meaningText(one!)]);
    expect(current(one!)).toBe(true);
    expect(two!.embedding).toBeNull();
  });

  it("asks the model for one listing at a time, with the pass and several writes at once (ADR 0014)", async () => {
    for (const host of ["a", "b", "c", "d", "e"]) await list(host, { description: host });
    const { embedder, state } = fakeEmbedder();
    const searchVectors = vectors(embedder);
    await Promise.all([
      searchVectors.start(),
      ...["a", "b", "c"].map((host) => searchVectors.listed(key(host))),
    ]);
    expect(state.calls.length).toBeGreaterThanOrEqual(5);
    expect(state.maxInFlight).toBe(1);
  });

  it("logs and counts a failure, and resolves: the listing stays stored", async () => {
    await list("one", { description: "Weather one" });
    const { embedder } = fakeEmbedder(() => true);
    const lines: string[] = [];
    const metrics = memoryMetrics();
    await expect(vectors(embedder, lines, metrics).listed(key("one"))).resolves.toBeUndefined();
    expect(metrics.value("search_vector_failures_total")).toBe(1);
    expect(parsed(lines)).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "search_vector_failed",
        error: expect.objectContaining({ message: expect.stringContaining("model failed") }),
      }),
    );
    const cards = await readCards(db.pool);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.embedding).toBeNull();
  });
});

describe("main() and the vector pass (0120 C, F)", () => {
  const bootSecret = Keypair.random().secret();
  const bootChannel = Keypair.random().publicKey();
  let rpc: Awaited<ReturnType<typeof rpcStub>>;
  let model: Server;
  let modelUrl: string;
  const asked: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  beforeAll(async () => {
    rpc = await rpcStub({ [bootChannel]: hardened(Keypair.fromSecret(bootSecret).publicKey()) });
    // The search model container, as the facilitator sees it.
    model = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const { text } = JSON.parse(body) as { text: string };
        asked.push(text);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ model: MODEL, vector: vectorFor(text) }));
      });
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await rpc.close();
    await new Promise((resolve) => model.close(resolve));
  });

  it("embeds every card after the start's card rewrite, one at a time", async () => {
    await db.empty();
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    // A card the start's rewrite changes: the vector must be of the rewritten text.
    await db.pool.query("UPDATE catalog_search SET name = 'old' WHERE name <> 'old'");
    const app = await main({
      DATABASE_URL: db.urlFor(db.schema),
      ...signerEnv(Keypair.fromSecret(bootSecret).publicKey()),
      CLIENT_IP: "socket",
      CHANNELS: bootChannel,
      RPC_URLS: rpc.url,
      PORT: "0",
      LOG_LEVEL: "error",
      SEARCH_MODEL_URL: modelUrl,
    });
    try {
      await app.searchCardsRewritten;
      await vi.waitFor(async () => expect((await readCards(db.pool)).every(current)).toBe(true), {
        timeout: 5_000,
      });
      expect(maxInFlight).toBe(1);
      expect(asked.every((text) => !text.startsWith("old"))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
