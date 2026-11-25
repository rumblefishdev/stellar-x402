import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SpendStore } from "../src/ports/index.js";
import { REFUSED_HORIZON_MS, createPruner, type PrunerDeps } from "../src/pruner.js";
import { testDatabase } from "./database.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const big = 10n ** 15n;
const LEDGER = 1_000;

const db = testDatabase();
beforeEach(db.empty);

function recordingLogger() {
  const events: { level: string; event: string; fields?: LogFields }[] = [];
  const at = (level: string) => (event: string, fields?: LogFields) =>
    void events.push({ level, event, fields });
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return { logger, events };
}

function deps(overrides: Partial<PrunerDeps> = {}): PrunerDeps {
  return {
    settlements: db.stores().settlements,
    ledger: { network: "stellar:testnet", latest: async () => LEDGER },
    spend: db.stores().spend,
    rateLimits: db.stores().rateLimits,
    catalogAttempts: db.stores().catalogAttempts,
    spendWindowMs: DAY,
    rateLimitWindowMs: 60_000,
    logger: recordingLogger().logger,
    metrics: memoryMetrics(),
    now: () => NOW,
    ...overrides,
  };
}

const reserveAt = (spend: SpendStore, id: string, at: number, windowMs = DAY) =>
  spend.reserve({
    id,
    amount: 1n,
    limits: [{ scope: "global", maxStroops: big, windowMs }],
    now: at,
  });

describe("pruner", () => {
  afterEach(() => vi.useRealTimers());

  it("prunes spend past the longer of two windows and 7 days, and rate limits past one window", async () => {
    const { spend, rateLimits } = db.stores();
    await reserveAt(spend, "old", NOW - 7 * DAY - 1);
    await reserveAt(spend, "kept", NOW - 7 * DAY);
    await rateLimits.hit("ended", 60_000, NOW - 120_001);
    await rateLimits.hit("previous", 60_000, NOW - 60_000);
    await createPruner(deps({ spend, rateLimits })).runOnce();
    expect(await spend.used("global", 30 * DAY, NOW)).toBe(1n);
    // Its window ended at NOW - 120 000; pruned, so this hit starts it again.
    expect(await rateLimits.hit("ended", 60_000, NOW - 120_001)).toEqual({
      count: 1,
      resetAt: NOW - 120_000,
    });
    expect((await rateLimits.hit("previous", 60_000, NOW - 60_000)).count).toBe(2);

    // A 5-day window keeps 10 days.
    await db.empty();
    const long = db.stores().spend;
    await reserveAt(long, "old", NOW - 10 * DAY - 1, 5 * DAY);
    await reserveAt(long, "kept", NOW - 10 * DAY, 5 * DAY);
    await createPruner(deps({ spend: long, spendWindowMs: 5 * DAY })).runOnce();
    expect(await long.used("global", 30 * DAY, NOW)).toBe(1n);
  });

  it("prunes listing attempts older than 30 days (0063 row 23)", async () => {
    const { catalogAttempts } = db.stores();
    const attempt = (at: number) =>
      catalogAttempts.record({
        at,
        network: "stellar:testnet",
        payTo: "GPAYTO",
        payer: "GPAYER",
        stage: "payment",
        outcome: "unchanged",
      });
    await attempt(NOW - 30 * DAY - 1);
    await attempt(NOW - 30 * DAY);
    await createPruner(deps({ catalogAttempts })).runOnce();
    const { rows } = await db.pool.query("SELECT at FROM catalog_attempts");
    expect(rows).toEqual([{ at: String(NOW - 30 * DAY) }]);
  });

  const refusedAt = (nonce: string, createdAt: number) => ({
    key: `stellar:testnet:GPAYER:${nonce}` as const,
    network: "stellar:testnet" as const,
    payer: "GPAYER",
    nonce,
    fingerprint: `fp-${nonce}`,
    paymentPayload: { x402Version: 2 } as never,
    paymentRequirements: { asset: "CASSET" } as never,
    createdAt,
  });
  const FEE = "invalid_exact_stellar_payload_fee_exceeds_maximum";
  const nonces = async () =>
    (
      await db.pool.query<{ nonce: string }>("SELECT nonce FROM settlements ORDER BY nonce")
    ).rows.map((r) => r.nonce);

  it("prunes refused settlements past their hour, and no other settlement (0086)", async () => {
    const { settlements } = db.stores();
    const refusal = { errorReason: FEE };
    await settlements.refuse(refusedAt("1", NOW - REFUSED_HORIZON_MS - 1), refusal, [], NOW);
    await settlements.refuse(refusedAt("2", NOW - REFUSED_HORIZON_MS), refusal, [], NOW);
    await settlements.claim(refusedAt("3", NOW - DAY));
    await createPruner(deps({ settlements })).runOnce();
    expect(await nonces()).toEqual(["2", "3"]);
  });

  it("keeps a success settlement's listing through a prune run (0154)", async () => {
    const { settlements, catalog } = db.stores();
    const paid = refusedAt("1", NOW - 365 * DAY);
    await settlements.claim(paid);
    await settlements.transition(paid.key, "claimed", { state: "success", updatedAt: NOW });
    await catalog.linkPayment({
      settlementKey: paid.key,
      key: {
        network: "stellar:testnet",
        payTo: "GPAYTO",
        method: "GET",
        resourceUrl: "https://seller.example.com/data",
      },
    });
    await settlements.refuse(refusedAt("2", NOW - DAY), { errorReason: FEE }, [], NOW);
    await createPruner(deps({ settlements })).runOnce();
    const { rows } = await db.pool.query(
      "SELECT nonce, state, listing_method, listing_url FROM settlements",
    );
    expect(rows).toEqual([
      {
        nonce: "1",
        state: "success",
        listing_method: "GET",
        listing_url: "https://seller.example.com/data",
      },
    ]);
  });

  it("keeps a refused settlement past its hour until its expiration ledger has closed (0086, #205)", async () => {
    // Signed for thousands of ledgers and refused for its fee: it can pass every check later.
    const { settlements } = db.stores();
    const old = NOW - DAY;
    await settlements.refuse(
      refusedAt("1", old),
      { errorReason: FEE, expirationLedger: LEDGER },
      [],
      NOW,
    );
    await settlements.refuse(
      refusedAt("2", old),
      { errorReason: FEE, expirationLedger: LEDGER + 1 },
      [],
      NOW,
    );
    await createPruner(deps({ settlements })).runOnce();
    expect(await nonces()).toEqual(["2"]);
  });

  it("prunes only refusals without an expiration ledger when the ledger read fails (0086, #205)", async () => {
    const { settlements } = db.stores();
    const old = NOW - DAY;
    await settlements.refuse(refusedAt("1", old), { errorReason: FEE }, [], NOW);
    await settlements.refuse(
      refusedAt("2", old),
      { errorReason: FEE, expirationLedger: 1 },
      [],
      NOW,
    );
    const { logger, events } = recordingLogger();
    const metrics = memoryMetrics();
    const latest = async (): Promise<number> => {
      throw new Error("rpc down");
    };
    await createPruner(
      deps({ settlements, ledger: { network: "stellar:testnet", latest }, logger, metrics }),
    ).runOnce();
    expect(await nonces()).toEqual(["2"]);
    expect(events).toContainEqual(
      expect.objectContaining({ level: "warn", event: "store_prune_ledger_failed" }),
    );
    expect(metrics.value("store_prune_failures_total", { table: "settlements_refused" })).toBe(1);
  });

  it("prunes quiescent spend_scopes rows, keeping those with an open breaker (0024)", async () => {
    const { spend } = db.stores();
    await db.pool.query("INSERT INTO spend_scopes (scope, window_start) VALUES ('payer:GONE', 1)");
    await db.pool.query(
      "INSERT INTO spend_scopes (scope, breaker_until) VALUES ('asset:OPEN', $1)",
      [NOW + DAY],
    );
    await createPruner(deps({ spend })).runOnce();
    const { rows } = await db.pool.query<{ scope: string }>(
      "SELECT scope FROM spend_scopes ORDER BY scope",
    );
    expect(rows.map((r) => r.scope)).toEqual(["asset:OPEN"]);
  });

  it("prunes in batches until one comes back short, each table within its own time budget", async () => {
    // A flood: every batch comes back full, and each takes 300 ms.
    let clock = 0;
    const calls = { spend: 0, rate: 0 };
    const full = (key: keyof typeof calls) => async (_before: number, limit: number) => {
      calls[key]++;
      clock += 300;
      return limit;
    };
    const { logger, events } = recordingLogger();
    await createPruner(
      deps({
        spend: { prune: full("spend"), pruneScopes: async () => 0 },
        rateLimits: { prune: full("rate") },
        logger,
        clock: () => clock,
      }),
    ).runOnce();
    // 1 s each: the batch that crosses it is the last.
    expect(calls).toEqual({ spend: 4, rate: 4 });
    expect(events.filter((e) => e.event === "store_pruned")).toEqual([
      {
        level: "info",
        event: "store_pruned",
        fields: { table: "spend_reservations", rows: 4_000, complete: false },
      },
      {
        level: "info",
        event: "store_pruned",
        fields: { table: "rate_limits", rows: 4_000, complete: false },
      },
    ]);

    // A short batch ends a table's run; nothing pruned logs nothing.
    const short = recordingLogger();
    await createPruner(
      deps({
        spend: { prune: async () => 7, pruneScopes: async () => 0 },
        rateLimits: { prune: async () => 0 },
        logger: short.logger,
      }),
    ).runOnce();
    expect(short.events).toEqual([
      {
        level: "info",
        event: "store_pruned",
        fields: { table: "spend_reservations", rows: 7, complete: true },
      },
    ]);
  });

  it("logs and counts a failed prune, and still prunes the other table", async () => {
    const { logger, events } = recordingLogger();
    const metrics = memoryMetrics();
    const { rateLimits } = db.stores();
    await rateLimits.hit("ended", 60_000, 0);
    const error = new Error("connection terminated");
    await createPruner(
      deps({
        spend: { prune: () => Promise.reject(error), pruneScopes: async () => 0 },
        rateLimits,
        logger,
        metrics,
      }),
    ).runOnce();
    expect(events).toContainEqual({
      level: "warn",
      event: "store_prune_failed",
      fields: { table: "spend_reservations", rows: 0, error },
    });
    expect(metrics.value("store_prune_failures_total", { table: "spend_reservations" })).toBe(1);
    expect(await rateLimits.prune(NOW, 10)).toBe(0);
  });

  it("logs the rows earlier batches deleted when a later one fails", async () => {
    const { logger, events } = recordingLogger();
    const error = new Error("connection terminated");
    const prune = vi
      .fn<(before: number, limit: number) => Promise<number>>()
      .mockResolvedValueOnce(1_000)
      .mockResolvedValueOnce(1_000)
      .mockRejectedValueOnce(error);
    await createPruner(deps({ spend: { prune, pruneScopes: async () => 0 }, logger })).runOnce();
    expect(events).toContainEqual({
      level: "warn",
      event: "store_prune_failed",
      fields: { table: "spend_reservations", rows: 2_000, error },
    });
  });

  it("runs every interval with ±10% jitter, and close() waits for a running tick and stops", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let ticks = 0;
    const spend = {
      prune: async () => {
        ticks++;
        await new Promise<void>((resolve) => (release = resolve));
        return 0;
      },
      pruneScopes: async () => 0,
    };
    // random() = 0: the earliest a tick may come, 54 s.
    const pruner = createPruner(deps({ spend, random: () => 0 }));
    pruner.start();
    await vi.advanceTimersByTimeAsync(53_999);
    expect(ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks).toBe(1);
    let closed = false;
    const closing = pruner.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    release();
    await closing;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ticks).toBe(1);
  });
});
