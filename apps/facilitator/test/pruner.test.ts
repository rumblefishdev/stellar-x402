import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, MemorySpendStore } from "../src/adapters/memory.js";
import type { LogFields, Logger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import { createPruner, type PrunerDeps } from "../src/pruner.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const big = 10n ** 15n;

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
    spend: new MemorySpendStore(),
    rateLimits: new MemoryRateLimitStore(),
    spendWindowMs: DAY,
    rateLimitWindowMs: 60_000,
    logger: recordingLogger().logger,
    metrics: memoryMetrics(),
    now: () => NOW,
    ...overrides,
  };
}

const reserveAt = (spend: MemorySpendStore, id: string, at: number, windowMs = DAY) =>
  spend.reserve({
    id,
    amount: 1n,
    limits: [{ scope: "global", maxStroops: big, windowMs }],
    now: at,
  });

describe("pruner", () => {
  afterEach(() => vi.useRealTimers());

  it("prunes spend past the longer of two windows and 7 days, and rate limits past one window", async () => {
    const spend = new MemorySpendStore();
    const rateLimits = new MemoryRateLimitStore();
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
    const long = new MemorySpendStore();
    await reserveAt(long, "old", NOW - 10 * DAY - 1, 5 * DAY);
    await reserveAt(long, "kept", NOW - 10 * DAY, 5 * DAY);
    await createPruner(deps({ spend: long, spendWindowMs: 5 * DAY })).runOnce();
    expect(await long.used("global", 30 * DAY, NOW)).toBe(1n);
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
        spend: { prune: full("spend") },
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
        spend: { prune: async () => 7 },
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
    const rateLimits = new MemoryRateLimitStore();
    await rateLimits.hit("ended", 60_000, 0);
    const error = new Error("connection terminated");
    await createPruner(
      deps({
        spend: { prune: () => Promise.reject(error) },
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
    await createPruner(deps({ spend: { prune }, logger })).runOnce();
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
