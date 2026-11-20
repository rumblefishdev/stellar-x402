import { byName, seriesDims } from "@stellar-x402/metrics-catalog";
import { describe, expect, test, vi } from "vitest";
import {
  METRICS,
  NAMESPACE,
  UNIT,
  readReady,
  readyMetricData,
  runProbe,
  targetFromEnv,
} from "../lambdas/uptime-probe/probe.mjs";

const URL = "https://x402-facilitator.sorobanscan.com/health";
const HUB_URL = "https://sorobanscan.com/api/hub/me";
const READY = { ready: true } as const;
const SIGNED_OUT = { authenticated: false } as const;
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
    const r = await readReady({ url: URL, expect: READY, fetch });
    expect(r.ready).toBe(ready);
    expect(r.reason).toMatch(reason);
  });

  test("gives up after its timeout and reads 0", async () => {
    const hang: Fetch = (_, init) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const r = await readReady({ url: URL, expect: READY, fetch: hang, timeoutMs: 20 });
    expect(r).toMatchObject({ ready: 0, reason: expect.stringMatching(/TimeoutError/) });
  });

  test("closes the body of an answer it doesn't read", async () => {
    const res = new Response("Bad gateway", { status: 502 });
    const cancel = vi.spyOn(res.body!, "cancel");
    await readReady({ url: URL, expect: READY, fetch: async () => res });
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("asks without following redirects, as the probe", async () => {
    const fetch = vi.fn(answer(200, '{"ready":true}'));
    await readReady({ url: URL, expect: READY, fetch });
    expect(fetch).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({ "user-agent": "x402-uptime-probe" }),
      }),
    );
  });
});

describe("readReady on the API hub's backend, through the explorer's CloudFront", () => {
  const html = "<!doctype html><title>Soroban Block Explorer</title>";
  test.each<[string, Fetch, 0 | 1, RegExp]>([
    ["the hub's answer without a session", answer(200, '{"authenticated":false}'), 1, /ready/],
    [
      "an answer for a session, which the probe never has",
      answer(200, '{"authenticated":true,"id":"1","username":"x"}'),
      0,
      /authenticated is true/,
    ],
    ["authenticated as a string", answer(200, '{"authenticated":"false"}'), 0, /is "false"/],
    ["JSON without the field", answer(200, '{"ready":true}'), 0, /authenticated is undefined/],
    ["a JSON array", answer(200, "[false]"), 0, /authenticated is undefined/],
    ["the explorer's page with a 200", answer(200, html), 0, /SyntaxError/],
    ["the explorer's page with a 403", answer(403, html), 0, /status 403/],
    ["the distribution's redirect to /api/, before the hub is routed", answer(302, ""), 0, /302/],
    ["a 502 from the hub's Lambda", answer(502, '{"message":"Internal"}'), 0, /status 502/],
  ])("reads %s", async (_, fetch, ready, reason) => {
    const r = await readReady({ url: HUB_URL, expect: SIGNED_OUT, fetch });
    expect(r.ready).toBe(ready);
    expect(r.reason).toMatch(reason);
  });

  test("needs every field of its expectation, and names the first that differs", async () => {
    const expect2 = { ready: true, listed: true };
    const ok = await readReady({
      url: URL,
      expect: expect2,
      fetch: answer(200, '{"ready":true,"listed":true}'),
    });
    expect(ok.ready).toBe(1);
    const off = await readReady({
      url: URL,
      expect: expect2,
      fetch: answer(200, '{"ready":true,"listed":false}'),
    });
    expect(off).toEqual({ ready: 0, reason: "listed is false" });
  });

  test("never reads an inherited field as the body's", async () => {
    const r = await readReady({
      url: URL,
      expect: { constructor: null },
      fetch: answer(200, "{}"),
    });
    expect(r).toEqual({ ready: 0, reason: "constructor is undefined" });
  });
});

describe("targetFromEnv", () => {
  const env = {
    HEALTH_URL: HUB_URL,
    METRIC: "hub_ready",
    EXPECT: '{"authenticated":false}',
  };

  test("reads the URL, the metric and the expected fields the stack sets", () => {
    expect(targetFromEnv(env)).toEqual({
      url: HUB_URL,
      metric: "hub_ready",
      expect: { authenticated: false },
    });
  });

  test.each<[string, Record<string, string | undefined>, RegExp]>([
    ["no URL", { ...env, HEALTH_URL: undefined }, /HEALTH_URL is not set/],
    ["no metric", { ...env, METRIC: undefined }, /METRIC must be one of/],
    ["a metric outside the probes'", { ...env, METRIC: "spendable_stroops" }, /METRIC must be/],
    ["no expectation", { ...env, EXPECT: undefined }, /EXPECT is not set/],
    ["an expectation that isn't JSON", { ...env, EXPECT: "ready" }, /JSON/],
    ["an empty expectation, which anything meets", { ...env, EXPECT: "{}" }, /at least one/],
    ["an array", { ...env, EXPECT: "[true]" }, /EXPECT must be/],
    ["a nested field", { ...env, EXPECT: '{"a":{"b":1}}' }, /EXPECT must be/],
  ])("refuses %s", (_, e, message) => {
    expect(() => targetFromEnv(e)).toThrow(message);
  });
});

describe("what it publishes", () => {
  test("is the catalog's x402-watch metric it names: no dimensions, its unit", () => {
    const at = new Date("2026-11-04T12:00:00Z");
    expect(readyMetricData("ready", 1, at)).toEqual({
      Namespace: "x402-watch",
      MetricData: [{ MetricName: "ready", Value: 1, Unit: "None", Timestamp: at }],
    });
    expect(readyMetricData("hub_ready", 0, at).MetricData[0]).toMatchObject({
      MetricName: "hub_ready",
      Value: 0,
    });
    expect(METRICS).toEqual(["ready", "portal_ready", "hub_ready"]);
    for (const metric of METRICS) {
      expect(seriesDims(metric, {}), metric).toEqual({ ok: true, namespace: NAMESPACE });
      expect(byName(metric)?.unit, metric).toBe(UNIT);
    }
  });
});

describe("runProbe", () => {
  test("publishes one point per run and logs what it read", async () => {
    const publish = vi.fn<(input: unknown) => Promise<object>>(async () => ({}));
    const log = vi.fn();
    const r = await runProbe({
      url: URL,
      metric: "ready",
      expect: READY,
      fetch: answer(502, ""),
      publish,
      log,
    });
    expect(r.ready).toBe(0);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ MetricData: [{ Value: 0 }] });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ ready: 0, reason: "status 502" }));
  });

  test("publishes and logs under its target's metric", async () => {
    const publish = vi.fn<(input: unknown) => Promise<object>>(async () => ({}));
    const log = vi.fn();
    await runProbe({
      url: HUB_URL,
      metric: "hub_ready",
      expect: SIGNED_OUT,
      fetch: answer(200, '{"authenticated":false}'),
      publish,
      log,
    });
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      MetricData: [{ MetricName: "hub_ready", Value: 1 }],
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ url: HUB_URL, metric: "hub_ready", ready: 1 }),
    );
  });

  test("stamps the point with the time the run started, not when the read ended", async () => {
    const times = [new Date("2026-11-04T12:00:55Z"), new Date("2026-11-04T12:01:05Z")];
    const publish = vi.fn<(input: unknown) => Promise<object>>(async () => ({}));
    await runProbe({
      url: URL,
      metric: "ready",
      expect: READY,
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
      runProbe({
        url: URL,
        metric: "ready",
        expect: READY,
        fetch: answer(200, '{"ready":true}'),
        publish,
        log: () => {},
      }),
    ).rejects.toThrow("AccessDenied");
  });
});
