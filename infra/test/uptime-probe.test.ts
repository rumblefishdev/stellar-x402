import { byName, seriesDims } from "@stellar-x402/metrics-catalog";
import { describe, expect, test, vi } from "vitest";
import {
  METRIC,
  NAMESPACE,
  UNIT,
  readReady,
  readyMetricData,
  runProbe,
} from "../lambdas/uptime-probe/probe.mjs";

const URL = "https://x402-facilitator.sorobanscan.com/health";
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const answer =
  (status: number, body: string): Fetch =>
  async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });

describe("readReady", () => {
  test.each<[string, Fetch, 0 | 1, RegExp]>([
    ["a ready facilitator", answer(200, '{"ready":true,"signer":"ok","listed":true}'), 1, /ready/],
    [
      "ready false",
      answer(200, '{"ready":false,"signer":"ok","listed":true}'),
      0,
      /ready is false/,
    ],
    ["ready as a string", answer(200, '{"ready":"true"}'), 0, /ready is "true"/],
    ["no ready field", answer(200, "{}"), 0, /ready is undefined/],
    ["a 502 before the first deploy", answer(502, "Bad gateway"), 0, /status 502/],
    ["a 503", answer(503, '{"ready":true}'), 0, /status 503/],
    ["a redirect", answer(302, ""), 0, /status 302/],
    ["a body that isn't JSON", answer(200, "<html>"), 0, /SyntaxError/],
    ["a body that is null", answer(200, "null"), 0, /ready is undefined/],
    [
      "a failed connection",
      async () => {
        throw new TypeError("fetch failed");
      },
      0,
      /TypeError: fetch failed/,
    ],
  ])("reads %s", async (_, fetch, ready, reason) => {
    const r = await readReady({ url: URL, fetch });
    expect(r.ready).toBe(ready);
    expect(r.reason).toMatch(reason);
  });

  test("gives up after its timeout and reads 0", async () => {
    const hang: Fetch = (_, init) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const r = await readReady({ url: URL, fetch: hang, timeoutMs: 20 });
    expect(r).toMatchObject({ ready: 0, reason: expect.stringMatching(/TimeoutError/) });
  });

  test("closes the body of an answer it doesn't read", async () => {
    const res = new Response("Bad gateway", { status: 502 });
    const cancel = vi.spyOn(res.body!, "cancel");
    await readReady({ url: URL, fetch: async () => res });
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("asks without following redirects, as the probe", async () => {
    const fetch = vi.fn(answer(200, '{"ready":true}'));
    await readReady({ url: URL, fetch });
    expect(fetch).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({ "user-agent": "x402-uptime-probe" }),
      }),
    );
  });
});

describe("what it publishes", () => {
  test("is the catalog's x402-watch ready: no dimensions, its unit", () => {
    const at = new Date("2026-11-04T12:00:00Z");
    const input = readyMetricData(1, at);
    expect(input).toEqual({
      Namespace: "x402-watch",
      MetricData: [{ MetricName: "ready", Value: 1, Unit: "None", Timestamp: at }],
    });
    expect(seriesDims(METRIC, {})).toEqual({ ok: true, namespace: NAMESPACE });
    expect(byName(METRIC)?.unit).toBe(UNIT);
  });
});

describe("runProbe", () => {
  test("publishes one point per run and logs what it read", async () => {
    const publish = vi.fn<(input: unknown) => Promise<object>>(async () => ({}));
    const log = vi.fn();
    const r = await runProbe({ url: URL, fetch: answer(502, ""), publish, log });
    expect(r.ready).toBe(0);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ MetricData: [{ Value: 0 }] });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ ready: 0, reason: "status 502" }));
  });

  test("stamps the point with the time the run started, not when the read ended", async () => {
    const times = [new Date("2026-11-04T12:00:55Z"), new Date("2026-11-04T12:01:05Z")];
    const publish = vi.fn<(input: unknown) => Promise<object>>(async () => ({}));
    await runProbe({
      url: URL,
      fetch: answer(200, '{"ready":true}'),
      publish,
      log: () => {},
      now: () => times.shift()!,
    });
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      MetricData: [{ Timestamp: new Date("2026-11-04T12:00:55Z") }],
    });
  });

  test("fails the run when the publish fails, so the point is missing and counts as down", async () => {
    const publish = vi.fn(async () => {
      throw new Error("AccessDenied");
    });
    await expect(
      runProbe({ url: URL, fetch: answer(200, '{"ready":true}'), publish, log: () => {} }),
    ).rejects.toThrow("AccessDenied");
  });
});
