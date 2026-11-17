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

  describe("hold (0090)", () => {
    const later = () => {
      let end!: () => void;
      const until = new Promise<void>((r) => (end = r));
      return { until, end };
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it("keeps a free channel from callers until the hold ends, then reads its sequence again", async () => {
      const pool = new ChannelPool(["A", "B"]);
      const a = await pool.acquire();
      a.sequence = 7n;
      pool.release(a);
      const h = later();
      pool.hold("A", h.until);
      expect(pool.held).toBe(1);
      const b = await pool.acquire();
      expect(b.address).toBe("B");
      const waiter = pool.acquire();
      expect(pool.queued).toBe(1);

      h.end();
      const served = await waiter;
      expect(served.address).toBe("A");
      expect(served.sequence).toBeUndefined();
      expect(pool.held).toBe(0);
    });

    it("parks a channel held while in use once its caller releases it", async () => {
      const pool = new ChannelPool(["A"]);
      const a = await pool.acquire();
      const h = later();
      pool.hold("A", h.until);
      expect(pool.isHeld(a)).toBe(true);
      expect(() => pool.handOver(a)).toThrow("under a hold");
      pool.release(a);
      expect(() => pool.release(a)).toThrow("released twice");
      expect(() => pool.retire(a)).toThrow("is not held");

      const waiter = pool.acquire();
      await tick();
      expect(pool.queued).toBe(1);
      h.end();
      expect((await waiter).address).toBe("A");
    });

    it("leaves a channel with its caller when the hold ends before the release", async () => {
      const pool = new ChannelPool(["A"]);
      const a = await pool.acquire();
      a.sequence = 5n;
      const h = later();
      pool.hold("A", h.until);
      h.end();
      await tick();
      expect(pool.isHeld(a)).toBe(false);
      expect(a.sequence).toBe(5n);
      pool.release(a);
      expect((await pool.acquire()).address).toBe("A");
    });

    it("returns the channel only when the last of stacked holds ends, rejected ones too", async () => {
      const pool = new ChannelPool(["A"]);
      const first = later();
      let fail!: (e: Error) => void;
      const second = new Promise<void>((_, reject) => (fail = reject));
      pool.hold("A", first.until);
      pool.hold("A", second);
      const waiter = pool.acquire();
      first.end();
      await tick();
      expect(pool.queued).toBe(1);
      fail(new Error("store down"));
      expect((await waiter).address).toBe("A");
    });

    it("refuses an unknown channel", () => {
      const pool = new ChannelPool(["A"]);
      expect(() => pool.hold("Z", Promise.resolve())).toThrow("unknown channel Z");
    });
  });
});
