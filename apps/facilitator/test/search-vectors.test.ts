import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import { SEARCH_MODEL_ID } from "@stellar-x402/config";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSearchVectors,
  SEARCH_VECTORS_TICK_MS,
  type SearchVectors,
  type SearchVectorsDeps,
} from "../src/catalog/search-vectors.js";
import { jsonLogger } from "../src/logger.js";
import { main } from "../src/main.js";
import { memoryMetrics } from "../src/metrics.js";
import type { CatalogKey } from "../src/ports/index.js";
import type { Embedder } from "../src/ports/embedder.js";
import type { Scheduler } from "../src/timers.js";
import { testDatabase } from "./database.js";
import { signerEnv } from "./fake-openbao.js";
import { hardened, rpcStub } from "./rpc-stub.js";
import { meaningText, readCards, sameVector, setVector, unitVector } from "./vectors.js";

// Every case here needs the `vector` extension (pgvector) in the test database.

// The facilitator's own model: main() refuses an answer of any other (ADR 0014).
const MODEL = SEARCH_MODEL_ID;

/** A vector of its own for each text, so a stored vector names the text it was made from. */
function vectorFor(text: string): number[] {
  const byte = createHash("sha256").update(text, "utf8").digest()[0]!;
  return unitVector(0.5 + (byte / 255) * 0.45);
}

/**
 * An embedder that records each text and the kind it is sent as, tracks how many calls run at
 * once, fails a text `fail` names, and waits on `hold` when one is set.
 */
function fakeEmbedder(fail: (text: string) => boolean = () => false) {
  const state = {
    calls: [] as string[],
    kinds: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    hold: undefined as Promise<void> | undefined,
    started: undefined as (() => void) | undefined,
  };
  const embedder: Embedder = {
    embed: async (text, kind) => {
      state.calls.push(text);
      state.kinds.push(kind);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        state.started?.();
        if (state.hold) await state.hold;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (fail(text)) throw new Error(`model failed on ${text.slice(0, 20)}`);
        return vectorFor(text);
      } finally {
        state.inFlight--;
      }
    },
  };
  return { embedder, state };
}

/** A health check that answers `up()` and counts how often it is asked. */
function healthCheck(up: () => boolean = () => true) {
  const check = { asked: 0, ready: async () => false };
  check.ready = async () => {
    check.asked++;
    return up();
  };
  return check;
}

/** Timers that fire only when the test says so; `ms` records each delay asked for. */
function fakeScheduler() {
  const timers = new Map<number, () => void>();
  const ms: number[] = [];
  let next = 0;
  const schedule: Scheduler = {
    setTimeout(fn, delay) {
      ms.push(delay);
      timers.set(++next, fn);
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  const tick = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
  };
  return { schedule, tick, ms, pending: () => timers.size };
}

/** Long enough for a run that has nothing to do to have ended. */
const idle = () => new Promise((resolve) => setTimeout(resolve, 100));

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

/** Every instance a test makes, closed after it, so no run outlives its test. */
const opened: SearchVectors[] = [];

/** The vector runs on the test's stores; their log lines, metrics and timers stay with the test. */
function vectors(
  embedder: Embedder,
  deps: Partial<Pick<SearchVectorsDeps, "ready" | "store">> = {},
) {
  const lines: string[] = [];
  const metrics = memoryMetrics();
  const timers = fakeScheduler();
  const searchVectors = createSearchVectors({
    store: deps.store ?? db.stores().searchCards,
    embedder,
    ready: deps.ready ?? (async () => true),
    logger: jsonLogger("debug", (line) => lines.push(line)),
    metrics,
    schedule: timers.schedule,
  });
  opened.push(searchVectors);
  return { searchVectors, lines, metrics, ...timers };
}

const parsed = (lines: string[]) => lines.map((line) => JSON.parse(line));
const events = (lines: string[], event: string) =>
  parsed(lines).filter((line) => line.event === event);

/** A card holds a current vector: of the model, made from its text as it is now. */
const current = (card: Awaited<ReturnType<typeof readCards>>[number]) =>
  card.model === MODEL && sameVector(card.embedding, vectorFor(meaningText(card)));

const allCurrent = async () => (await readCards(db.pool)).every(current);

beforeEach(() => db.empty());
afterEach(async () => {
  await Promise.all(opened.splice(0).map((searchVectors) => searchVectors.close()));
});

describe("the model's health in a vector run", () => {
  it("asks the health check once at a run's start, and up() follows its answer, 0 before the first", async () => {
    await list("one", { description: "Weather one" });
    const { embedder } = fakeEmbedder();
    const check = healthCheck();
    const { searchVectors, tick } = vectors(embedder, { ready: check.ready });
    expect(searchVectors.up()).toBe(0);
    await searchVectors.start();
    expect(check.asked).toBe(1);
    expect(searchVectors.up()).toBe(1);
    tick();
    await vi.waitFor(() => expect(check.asked).toBe(2));
    await idle();
    expect(check.asked).toBe(2);
  });

  it("embeds nothing while the model doesn't answer, and logs the wait once each time the model goes down", async () => {
    await list("one", { description: "Weather one" });
    const { embedder, state } = fakeEmbedder();
    let up = false;
    const check = healthCheck(() => up);
    const { searchVectors, tick, lines } = vectors(embedder, { ready: check.ready });
    const waiting = () => events(lines, "search_vectors_waiting_for_model");

    await searchVectors.start();
    expect(searchVectors.up()).toBe(0);
    expect(state.calls).toEqual([]);
    expect(waiting()).toEqual([expect.objectContaining({ level: "info" })]);

    // Still down on the next run: no second line.
    tick();
    await vi.waitFor(() => expect(check.asked).toBe(2));
    await idle();
    expect(state.calls).toEqual([]);
    expect(waiting()).toHaveLength(1);

    up = true;
    tick();
    await vi.waitFor(async () => expect(await allCurrent()).toBe(true));
    // The run ends after its last write; a tick before then would skip.
    await idle();
    expect(searchVectors.up()).toBe(1);
    expect(waiting()).toHaveLength(1);

    // Down again: the wait is logged again.
    up = false;
    tick();
    await vi.waitFor(() => expect(searchVectors.up()).toBe(0));
    await idle();
    expect(waiting()).toHaveLength(2);
  });
});

describe("the cards a vector run embeds", () => {
  it("embeds every card without a current vector, as a listing, and no card that has one", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    await list("three", { description: "Stocks three" });
    // three: its text changed after its vector was stored, so the vector no longer counts (ADR 0014).
    await setVector(db.pool, key("two"), MODEL, unitVector(0.7));
    await setVector(db.pool, key("three"), MODEL, unitVector(0.9));
    await list("three", { description: "Stocks three, daily" }, 2);
    const { embedder, state } = fakeEmbedder();
    const { searchVectors, tick } = vectors(embedder);
    await searchVectors.start();
    const [one, two, three] = await readCards(db.pool);
    expect(state.calls).toEqual([meaningText(one!), meaningText(three!)]);
    // A listing's text is read up to the model's 512 tokens, not a query's 256 (ADR 0014).
    expect(state.kinds).toEqual(["listing", "listing"]);
    expect([current(one!), current(three!)]).toEqual([true, true]);
    expect(sameVector(two!.embedding, unitVector(0.7))).toBe(true);
    // The next run finds every card current and asks the model nothing.
    tick();
    await idle();
    expect(state.calls).toHaveLength(2);
  });

  it("embeds again a card whose vector is of another model, as after a change of model", async () => {
    await list("one", { description: "Weather one" });
    await setVector(db.pool, key("one"), "old-model", unitVector(0.9));
    const { embedder, state } = fakeEmbedder();
    await vectors(embedder).searchVectors.start();
    const [one] = await readCards(db.pool);
    expect(state.calls).toEqual([meaningText(one!)]);
    expect(current(one!)).toBe(true);
  });

  it("reads the cards a page after another, past the first 100", async () => {
    for (let i = 0; i < 101; i++) await list(`h${i}`, { description: `Tides ${i}` });
    const { embedder, state } = fakeEmbedder();
    await vectors(embedder).searchVectors.start();
    const cards = await readCards(db.pool);
    expect(cards).toHaveLength(101);
    expect(cards.every(current)).toBe(true);
    expect(state.calls).toHaveLength(101);
    // 101 listings written and embedded one at a time.
  }, 20_000);

  it("embeds a card's fields joined with a line break, empty ones skipped", async () => {
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
    await vectors(embedder).searchVectors.start();
    const [rich, plain] = await readCards(db.pool);
    expect(state.calls[0]).toBe(
      [rich!.name, rich!.tags, rich!.description, rich!.parameters].join("\n"),
    );
    // No tags and no parameters: nothing of them, not even their line breaks.
    expect([plain!.tags, plain!.parameters]).toEqual(["", ""]);
    expect(state.calls[1]).toBe(`${plain!.name}\n${plain!.description}`);
  });

  it("sends the whole text, which the model cuts at 2,000 characters", async () => {
    await list("long", { description: "lorem ipsum ".repeat(400) });
    const { embedder, state } = fakeEmbedder();
    await vectors(embedder).searchVectors.start();
    const [card] = await readCards(db.pool);
    expect(state.calls).toEqual([meaningText(card!)]);
    expect(state.calls[0]!.length).toBeGreaterThan(2_000);
  });

  it("asks the model for one listing at a time", async () => {
    for (const host of ["a", "b", "c", "d", "e"]) await list(host, { description: host });
    const { embedder, state } = fakeEmbedder();
    await vectors(embedder).searchVectors.start();
    expect(state.calls).toHaveLength(5);
    expect(state.maxInFlight).toBe(1);
  });

  it("writes no vector over a listing whose text changed while it was embedded (ADR 0014)", async () => {
    await list("one", { description: "Weather" });
    const [before] = await readCards(db.pool);
    const old = meaningText(before!);
    const { embedder, state } = fakeEmbedder();
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    const underWay = new Promise<void>((resolve) => (state.started = resolve));
    const run = vectors(embedder).searchVectors.start();
    await underWay;
    // The catalog writes the listing again, with its card, while the model works.
    state.hold = undefined;
    await list("one", { description: "Tides" }, 2);
    release();
    await run;
    const [after] = await readCards(db.pool);
    expect(sameVector(after!.embedding, vectorFor(old))).toBe(false);
  });
});

describe("a card the model fails on", () => {
  it("is logged and counted while the model answers its health check, and the other cards get theirs", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Broken tides" });
    await list("three", { description: "Stocks three" });
    const { embedder } = fakeEmbedder((text) => text.includes("Broken"));
    const { searchVectors, lines, metrics } = vectors(embedder);
    await searchVectors.start();
    const [one, two, three] = await readCards(db.pool);
    expect([current(one!), current(three!)]).toEqual([true, true]);
    expect([two!.model, two!.embedding]).toEqual([null, null]);
    expect(metrics.value("search_vector_failures_total")).toBe(1);
    const {
      rows: [{ seq }],
    } = await db.pool.query("SELECT seq FROM catalog WHERE resource_url = $1", [
      key("two").resourceUrl,
    ]);
    expect(events(lines, "search_vector_failed")).toEqual([
      expect.objectContaining({
        level: "warn",
        seq,
        error: expect.objectContaining({ message: expect.stringContaining("model failed") }),
      }),
    ]);
  });

  it("is not tried again while its text is unchanged, and is once the listing's text changes", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Broken tides" });
    const { embedder, state } = fakeEmbedder((text) => text.includes("Broken"));
    const check = healthCheck();
    const { searchVectors, tick, lines, metrics } = vectors(embedder, { ready: check.ready });
    await searchVectors.start();
    expect(state.calls).toHaveLength(2);

    // The failure asked the health check again, to tell the card's fault from a model gone away.
    const asked = check.asked;
    tick();
    await vi.waitFor(() => expect(check.asked).toBe(asked + 1));
    await idle();
    expect(state.calls).toHaveLength(2);
    expect(metrics.value("search_vector_failures_total")).toBe(1);
    expect(events(lines, "search_vector_failed")).toHaveLength(1);

    // The seller lists it again with another description: a new text to embed.
    await list("two", { description: "Tides" }, 2);
    tick();
    await vi.waitFor(async () => expect(await allCurrent()).toBe(true));
    expect(state.calls).toHaveLength(3);
    expect(metrics.value("search_vector_failures_total")).toBe(1);
  });

  it("ends the run uncounted when the model went down meanwhile, and the next run embeds the card", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    let up = true;
    const { embedder, state } = fakeEmbedder(() => {
      // The model restarts as it is asked for the first card.
      if (state.calls.length === 1) {
        up = false;
        return true;
      }
      return false;
    });
    const { searchVectors, tick, lines, metrics } = vectors(embedder, { ready: async () => up });
    await searchVectors.start();
    expect(state.calls).toHaveLength(1);
    expect(searchVectors.up()).toBe(0);
    expect(metrics.value("search_vector_failures_total")).toBe(0);
    expect(events(lines, "search_vector_failed")).toEqual([]);
    expect(events(lines, "search_vectors_waiting_for_model")).toHaveLength(1);

    up = true;
    tick();
    await vi.waitFor(async () => expect(await allCurrent()).toBe(true));
    // The card it failed on first, then the one the first run never reached.
    expect(state.calls).toHaveLength(3);
    expect(state.calls[1]).toBe(state.calls[0]);
    expect(metrics.value("search_vector_failures_total")).toBe(0);
  });
});

describe("a failed read of the cards", () => {
  it("is logged and counted, ends the run, and a later run embeds the cards", async () => {
    await list("one", { description: "Weather one" });
    const { embedder, state } = fakeEmbedder();
    const store = db.stores().searchCards;
    let down = true;
    // The store's own methods, but a read of the cards that fails while `down`.
    const failing = Object.create(store) as typeof store;
    failing.cards = async (after, limit) => {
      if (down) throw new Error("database down");
      return store.cards(after, limit);
    };
    const { searchVectors, tick, lines, metrics } = vectors(embedder, { store: failing });
    await searchVectors.start();
    expect(metrics.value("search_vector_failures_total")).toBe(1);
    expect(events(lines, "search_vectors_read_failed")).toEqual([
      expect.objectContaining({
        level: "error",
        error: expect.objectContaining({ message: "database down" }),
      }),
    ]);
    expect(state.calls).toEqual([]);
    expect((await readCards(db.pool))[0]!.embedding).toBeNull();

    down = false;
    tick();
    await vi.waitFor(async () => expect(await allCurrent()).toBe(true));
    expect(metrics.value("search_vector_failures_total")).toBe(1);
  });
});

describe("the vector runs on a timer", () => {
  it("runs again every 30 s, so a card listed after the first run gets its vector on the next tick", async () => {
    expect(SEARCH_VECTORS_TICK_MS).toBe(30_000);
    await list("one", { description: "Weather one" });
    const { embedder } = fakeEmbedder();
    const { searchVectors, tick, ms } = vectors(embedder);
    await searchVectors.start();
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.every((delay) => delay === SEARCH_VECTORS_TICK_MS)).toBe(true);

    await list("two", { description: "Tides two" });
    tick();
    await vi.waitFor(async () => expect(await allCurrent()).toBe(true));
    await idle();
    await list("three", { description: "Stocks three" });
    tick();
    await vi.waitFor(async () => expect(await allCurrent()).toBe(true));
    expect(ms.every((delay) => delay === SEARCH_VECTORS_TICK_MS)).toBe(true);
  });

  it("starts no second run for a tick while one is under way, and keeps ticking after it", async () => {
    await list("one", { description: "Weather one" });
    const { embedder, state } = fakeEmbedder();
    const check = healthCheck();
    const { searchVectors, tick, pending } = vectors(embedder, { ready: check.ready });
    await searchVectors.start();
    // The next tick's run, held on its first card.
    await list("two", { description: "Tides two" });
    await list("three", { description: "Stocks three" });
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    const underWay = new Promise<void>((resolve) => (state.started = resolve));
    tick();
    await underWay;
    tick();
    await idle();
    expect(check.asked).toBe(2);
    expect(state.inFlight).toBe(1);
    release();
    await vi.waitFor(async () => expect(await allCurrent()).toBe(true));
    expect(state.maxInFlight).toBe(1);
    await idle();
    expect(pending()).toBeGreaterThan(0);
  });

  it("leaves no timer pending once closed, and a tick then does nothing", async () => {
    await list("one", { description: "Weather one" });
    const { embedder, state } = fakeEmbedder();
    const check = healthCheck();
    const { searchVectors, tick, pending } = vectors(embedder, { ready: check.ready });
    await searchVectors.start();
    await searchVectors.close();
    expect(pending()).toBe(0);
    await list("two", { description: "Tides two" });
    tick();
    await idle();
    expect(check.asked).toBe(1);
    expect(state.calls).toHaveLength(1);
  });
});

describe("closing during a vector run", () => {
  it("stops between cards, and close waits for the card under way to be written", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    const { embedder, state } = fakeEmbedder();
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));
    const underWay = new Promise<void>((resolve) => (state.started = resolve));
    const { searchVectors, lines } = vectors(embedder);
    const run = searchVectors.start();
    await underWay;
    let closed = false;
    const closing = searchVectors.close().then(() => (closed = true));
    await idle();
    expect(closed).toBe(false);
    release();
    await closing;
    await run;
    expect(state.calls).toHaveLength(1);
    const [one, two] = await readCards(db.pool);
    expect(current(one!)).toBe(true);
    expect(two!.embedding).toBeNull();
    expect(events(lines, "search_vectors_written")).toEqual([
      expect.objectContaining({ level: "info", written: 1, stopped: true }),
    ]);
  });
});

describe("the end of a vector run", () => {
  it("logs how many vectors it wrote, and nothing for a run that wrote none", async () => {
    for (const host of ["a", "b", "c"]) await list(host, { description: host });
    const { embedder } = fakeEmbedder();
    const check = healthCheck();
    const { searchVectors, tick, lines } = vectors(embedder, { ready: check.ready });
    await searchVectors.start();
    expect(events(lines, "search_vectors_written")).toEqual([
      expect.objectContaining({ level: "info", written: 3, stopped: false }),
    ]);
    tick();
    await vi.waitFor(() => expect(check.asked).toBe(2));
    await idle();
    expect(events(lines, "search_vectors_written")).toHaveLength(1);
  });
});

describe("main() and the vector runs (0120 C, F)", () => {
  const bootSecret = Keypair.random().secret();
  const bootChannel = Keypair.random().publicKey();
  let rpc: Awaited<ReturnType<typeof rpcStub>>;
  let model: Server;
  let modelUrl: string;
  const asked: string[] = [];
  const kinds: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  beforeAll(async () => {
    rpc = await rpcStub({ [bootChannel]: hardened(Keypair.fromSecret(bootSecret).publicKey()) });
    // The search model container, as the facilitator sees it.
    model = createServer((request, response) => {
      // Loaded at once: the run waits only for this answer.
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ model: MODEL }));
        return;
      }
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const { text, kind } = JSON.parse(body) as { text: string; kind: string };
        asked.push(text);
        kinds.push(kind);
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

  const boot = () =>
    main({
      DATABASE_URL: db.urlFor(db.schema),
      ...signerEnv(Keypair.fromSecret(bootSecret).publicKey()),
      CLIENT_IP: "socket",
      CHANNELS: bootChannel,
      RPC_URLS: rpc.url,
      PORT: "0",
      LOG_LEVEL: "error",
      SEARCH_MODEL_URL: modelUrl,
    });

  it("embeds every card after the start's card rewrite, one at a time", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    // A card the start's rewrite changes: the vector must be of the rewritten text.
    await db.pool.query("UPDATE catalog_search SET name = 'old' WHERE name <> 'old'");
    const app = await boot();
    try {
      await app.searchCardsRewritten;
      await vi.waitFor(async () => expect(await allCurrent()).toBe(true), { timeout: 5_000 });
      expect(maxInFlight).toBe(1);
      expect(asked.every((text) => !text.startsWith("old"))).toBe(true);
      expect(kinds.length).toBeGreaterThan(0);
      expect(kinds.every((kind) => kind === "listing")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("has every card current once the first vector run has ended", async () => {
    await list("one", { description: "Weather one" });
    await list("two", { description: "Tides two" });
    const app = await boot();
    try {
      await app.searchVectorsWritten;
      const cards = await readCards(db.pool);
      expect(cards).toHaveLength(2);
      expect(cards.every(current)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
