import { describe, expect, it } from "vitest";
import { accountAge, accountCreatedMs } from "../src/eligibility.js";
import { jsonLogger } from "../src/logger.js";
import { rateLimiter } from "../src/rate-limit.js";
import { sealer } from "../src/seal.js";

describe("a sealed key", () => {
  const KEY = `x402_${"k".repeat(43)}`;
  const OWNER = "discord:42";
  const HASH = "a".repeat(64);
  const seal = sealer(Buffer.alloc(32, 3));

  it("opens to the key, and is another ciphertext each time", () => {
    const [first, second] = [seal.seal(KEY, OWNER, HASH), seal.seal(KEY, OWNER, HASH)];
    expect(seal.open(first, OWNER, HASH)).toBe(KEY);
    expect(seal.open(second, OWNER, HASH)).toBe(KEY);
    expect(first.equals(second)).toBe(false);
    expect(first.includes(Buffer.from(KEY))).toBe(false);
    // The version, a 12-byte nonce, the 48 characters and a 16-byte tag.
    expect(first).toHaveLength(1 + 12 + 48 + 16);
  });

  it("doesn't open for another owner or another hash: a copy moved to another row is useless", () => {
    const sealed = seal.seal(KEY, OWNER, HASH);
    expect(seal.open(sealed, "discord:43", HASH)).toBeUndefined();
    expect(seal.open(sealed, OWNER, "b".repeat(64))).toBeUndefined();
  });

  it("doesn't open under another key, or when a byte of it changed or is missing", () => {
    const sealed = seal.seal(KEY, OWNER, HASH);
    expect(sealer(Buffer.alloc(32, 4)).open(sealed, OWNER, HASH)).toBeUndefined();
    for (let at = 0; at < sealed.length; at++) {
      const edited = Buffer.from(sealed);
      edited[at] = edited[at]! ^ 1;
      expect(seal.open(edited, OWNER, HASH), `byte ${at}`).toBeUndefined();
    }
    for (const length of [0, 1, 29, sealed.length - 1]) {
      expect(seal.open(sealed.subarray(0, length), OWNER, HASH)).toBeUndefined();
    }
  });

  it("opens only to something of a key's form", () => {
    expect(seal.open(seal.seal("not a key", OWNER, HASH), OWNER, HASH)).toBeUndefined();
  });
});

describe("the rate limiter", () => {
  it("counts each key apart, in windows that start at a key's first request", () => {
    let now = 0;
    const limiter = rateLimiter(2, 60_000, () => now);
    expect(limiter.hit("a")).toEqual({ allowed: true });
    now = 30_000;
    expect(limiter.hit("a")).toEqual({ allowed: true });
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(limiter.hit("b")).toEqual({ allowed: true });
    now = 59_999;
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now = 60_000;
    expect(limiter.hit("a")).toEqual({ allowed: true });
  });

  it("forgets ended windows once it holds many, and keeps the running ones", () => {
    let now = 0;
    const limiter = rateLimiter(1, 1_000, () => now);
    limiter.hit("kept");
    now = 500;
    for (let i = 0; i <= 10_000; i++) limiter.hit(`gone-${i}`);
    now = 999;
    // Still inside its window after the sweep that the many keys set off.
    limiter.hit("another");
    expect(limiter.hit("kept")).toMatchObject({ allowed: false });
  });
});

describe("the logger", () => {
  it("writes one JSON line, with an error's message and stack, at its level and above", () => {
    const lines: string[] = [];
    const logger = jsonLogger("info", (line) => lines.push(line));
    logger.debug("quiet");
    logger.info("signed_in", { owner: "discord:42", event: "overwritten?" });
    logger.error("failed", { error: new Error("boom", { cause: new Error("why") }) });
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "info",
      event: "signed_in",
      owner: "discord:42",
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      level: "error",
      error: { name: "Error", message: "boom", cause: { message: "why" } },
    });
  });
});

describe("a Discord account's age", () => {
  // The id of an account made at `ms`: the creation time sits in the top 42 bits.
  const idAt = (ms: number) => String((BigInt(ms) - 1_420_070_400_000n) << 22n);
  const NOW = Date.parse("2026-11-18T12:00:00Z");

  it("reads the creation time from the id", () => {
    expect(accountCreatedMs(idAt(NOW))).toBe(NOW);
    expect(accountCreatedMs("abc")).toBeUndefined();
    expect(accountCreatedMs("1".repeat(21))).toBeUndefined();
    expect(accountCreatedMs("")).toBeUndefined();
  });

  it("refuses an account 4 minutes old when 5 are needed, and says when it will do", () => {
    expect(accountAge(idAt(NOW - 4 * 60_000), 5, NOW)).toEqual({
      kind: "too_young",
      oldEnoughAt: "2026-11-18T12:01:00Z",
    });
  });

  it("rounds the time up to a whole second", () => {
    expect(accountAge(idAt(NOW - 4 * 60_000 + 400), 5, NOW)).toEqual({
      kind: "too_young",
      oldEnoughAt: "2026-11-18T12:01:01Z",
    });
  });

  it("takes an account exactly as old as the minimum, and any with a minimum of 0", () => {
    expect(accountAge(idAt(NOW - 5 * 60_000), 5, NOW)).toEqual({ kind: "old_enough" });
    expect(accountAge(idAt(NOW), 0, NOW)).toEqual({ kind: "old_enough" });
    // With no minimum there is nothing to wait for, even for an id stamped after now.
    expect(accountAge(idAt(NOW + 60_000), 0, NOW)).toEqual({ kind: "old_enough" });
  });

  it("says nothing of an id that isn't a snowflake", () => {
    expect(accountAge("abc", 5, NOW)).toBeUndefined();
  });
});
