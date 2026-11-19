import { describe, expect, it } from "vitest";
import { capOf, rfc3339 } from "../src/cap.js";

const at = (iso: string) => Date.parse(iso);

describe("rfc3339", () => {
  it("writes whole seconds in UTC, dropping milliseconds", () => {
    expect(rfc3339(at("2026-12-01T00:00:00.999Z"))).toBe("2026-12-01T00:00:00Z");
  });
});

describe("the month cap on a new key after a revoke", () => {
  const revoked = at("2026-08-03T14:30:00Z");

  it("holds until the first of the next month, at any instant of it", () => {
    for (const now of [
      "2026-08-03T14:30:00Z",
      "2026-08-04T00:00:00Z",
      "2026-08-20T12:00:00Z",
      "2026-08-31T23:59:59.999Z",
    ]) {
      expect(capOf(revoked, at(now))).toEqual({
        capped: true,
        nextEligibleAt: "2026-09-01T00:00:00Z",
      });
    }
  });

  it("lets go from the next month on", () => {
    expect(capOf(revoked, at("2026-09-01T00:00:00.000Z"))).toEqual({ capped: false });
    expect(capOf(revoked, at("2026-09-30T00:00:00Z"))).toEqual({ capped: false });
  });

  it("holds for a key revoked minutes ago in the same month", () => {
    const now = at("2026-08-15T10:00:00Z");
    expect(capOf(now - 5 * 60_000, now)).toEqual({
      capped: true,
      nextEligibleAt: "2026-09-01T00:00:00Z",
    });
  });

  it("counts the first millisecond of the month in, and the last one of the month before out", () => {
    expect(capOf(at("2026-08-01T00:00:00.000Z"), at("2026-08-15T00:00:00Z")).capped).toBe(true);
    expect(capOf(at("2026-07-31T23:59:59.999Z"), at("2026-08-01T00:00:00.000Z"))).toEqual({
      capped: false,
    });
  });

  it("rolls December into January of the next year", () => {
    expect(capOf(at("2026-12-10T08:00:00Z"), at("2026-12-20T00:00:00Z"))).toEqual({
      capped: true,
      nextEligibleAt: "2027-01-01T00:00:00Z",
    });
  });

  it("doesn't hold an account that never revoked", () => {
    expect(capOf(undefined, at("2026-08-15T00:00:00Z"))).toEqual({ capped: false });
  });
});
