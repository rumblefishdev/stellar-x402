import { describe, expect, it } from "vitest";
import { ChannelPool } from "../src/index.js";

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
