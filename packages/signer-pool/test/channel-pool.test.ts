import { describe, expect, it } from "vitest";
import { ChannelPool, NoChannelsError, QueueTimeoutError } from "../src/index.js";

describe("ChannelPool", () => {
  it("hands out free channels, then queues waiters first in, first out", async () => {
    const pool = new ChannelPool(["A", "B"]);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect([a.address, b.address]).toEqual(["A", "B"]);
    expect(pool.busy).toBe(2);

    const order: string[] = [];
    const w1 = pool.acquire().then((c) => order.push(`w1:${c.address}`));
    const w2 = pool.acquire().then((c) => order.push(`w2:${c.address}`));
    expect(pool.queued).toBe(2);
    pool.release(b);
    pool.release(a);
    await Promise.all([w1, w2]);
    expect(order).toEqual(["w1:B", "w2:A"]);
    expect(pool.queued).toBe(0);
  });

  it("ends a wait when onWait settles first, but not once a channel was handed out", async () => {
    const pool = new ChannelPool(["A"]);
    const a = await pool.acquire();
    let timeUp!: () => void;
    const waiting = pool.acquire(() => new Promise<void>((r) => (timeUp = r)));
    timeUp();
    await expect(waiting).rejects.toBeInstanceOf(QueueTimeoutError);
    expect(pool.queued).toBe(0);

    let late!: () => void;
    const served = pool.acquire(() => new Promise<void>((r) => (late = r)));
    pool.release(a);
    late();
    expect((await served).address).toBe("A");
  });

  it("retires a held channel and fails waiters when none are left", async () => {
    const pool = new ChannelPool(["A", "B"]);
    const a = await pool.acquire();
    const b = await pool.acquire();
    pool.retire(a);
    expect(pool.size).toBe(1);
    const waiter = pool.acquire();
    pool.retire(b);
    await expect(waiter).rejects.toBeInstanceOf(NoChannelsError);
    await expect(pool.acquire()).rejects.toBeInstanceOf(NoChannelsError);
  });

  it("rejects empty or duplicate pools and double releases", async () => {
    expect(() => new ChannelPool([])).toThrow();
    expect(() => new ChannelPool(["A", "A"])).toThrow("duplicate");
    const pool = new ChannelPool(["A"]);
    const a = await pool.acquire();
    pool.release(a);
    expect(() => pool.release(a)).toThrow("released twice");
    expect(() => pool.release({ address: "Z", sequence: undefined })).toThrow("unknown");
  });
});
