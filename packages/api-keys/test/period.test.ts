import { describe, expect, it } from "vitest";
import { monthEnd, monthStart, utcInstant } from "../src/period.js";

describe("the quota month", () => {
  it("starts on the 1st at 00:00:00.000 UTC, and the last millisecond is still the month's", () => {
    const last = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
    expect(monthStart(last)).toBe(Date.UTC(2026, 11, 1));
    expect(monthEnd(last)).toBe(Date.UTC(2027, 0, 1));
  });

  it("puts the 1st at 00:00:00.000 in the new month", () => {
    const first = Date.UTC(2026, 11, 1);
    expect(monthStart(first)).toBe(first);
    expect(monthEnd(first)).toBe(Date.UTC(2027, 0, 1));
    expect(monthStart(first - 1)).toBe(Date.UTC(2026, 10, 1));
  });

  it("ends a leap year's February after the 29th", () => {
    const leapDay = Date.UTC(2028, 1, 29, 12);
    expect(monthStart(leapDay)).toBe(Date.UTC(2028, 1, 1));
    expect(monthEnd(leapDay)).toBe(Date.UTC(2028, 2, 1));
    expect(monthEnd(Date.UTC(2027, 1, 28, 12))).toBe(Date.UTC(2027, 2, 1));
  });
});

describe("an instant in an answer", () => {
  it("is RFC 3339 in UTC, to the second", () => {
    expect(utcInstant(Date.UTC(2026, 11, 1))).toBe("2026-12-01T00:00:00Z");
    // Dropped, not rounded: the last millisecond of a month is still in it.
    expect(utcInstant(Date.UTC(2026, 10, 30, 23, 59, 59, 999))).toBe("2026-11-30T23:59:59Z");
  });
});
