import { seriesDims } from "@stellar-x402/metrics-catalog";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PutMetricDataInput } from "../src/watch/balance.js";
import { NAMESPACE } from "../src/watch/metric.js";
import {
  FILES,
  OUR_PIN_URL,
  UPSTREAM_METRIC,
  UPSTREAM_RAW,
  fetchText,
  isUpstreamRun,
  runUpstream,
} from "../src/watch/upstream.js";

const PIN = "8827cf19fa9a7b120588b8cc56f56a3def13bb97";
const PIN_FILE = `export const UPSTREAM_COMMIT = "${PIN}";\n`;
const AT = new Date("2026-11-06T08:00:00Z");

/** Upstream as `files` says: each path's text at the pin and on main. */
function harness(files: Record<string, { pin: string; main: string }>, pinFile = PIN_FILE) {
  const published: PutMetricDataInput[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetchText = async (url: string) => {
    if (url === OUR_PIN_URL) return pinFile;
    for (const [path, text] of Object.entries(files)) {
      if (url === `${UPSTREAM_RAW}/${PIN}/${path}`) return text.pin;
      if (url === `${UPSTREAM_RAW}/main/${path}`) return text.main;
    }
    throw new Error(`no fake for ${url}`);
  };
  const deps = {
    fetchText,
    publish: async (input: PutMetricDataInput) => {
      published.push(input);
    },
    log: (line: Record<string, unknown>) => logs.push(line),
    at: AT,
  };
  return { deps, published, logs };
}

const same = Object.fromEntries(FILES.map((path) => [path, { pin: "v1", main: "v1" }]));

describe("the upstream metric", () => {
  test("is the catalog's upstream_files_changed, with no dimension", () => {
    expect(seriesDims(UPSTREAM_METRIC, {})).toEqual({ ok: true, namespace: NAMESPACE });
  });
});

describe("runUpstream", () => {
  test("publishes 0 when every file at the pin equals upstream main", async () => {
    const h = harness(same);
    expect(await runUpstream(h.deps)).toEqual([]);
    expect(h.published).toEqual([
      {
        Namespace: NAMESPACE,
        MetricData: [
          { MetricName: UPSTREAM_METRIC, Dimensions: [], Value: 0, Unit: "Count", Timestamp: AT },
        ],
      },
    ]);
  });

  test("counts and logs each file upstream main changed since the pin", async () => {
    const changed = FILES[1]!;
    const h = harness({ ...same, [changed]: { pin: "v1", main: "v2" } });
    expect(await runUpstream(h.deps)).toEqual([changed]);
    expect(h.published[0]?.MetricData[0]?.Value).toBe(1);
    expect(h.logs).toContainEqual({ msg: "watch_upstream", pin: PIN, changed: [changed] });
  });

  test("compares the files the gate's suite rests on and the discovery spec", () => {
    expect(FILES).toEqual([
      "specs/x402-specification-v2.md",
      "specs/schemes/exact/scheme_exact_stellar.md",
      "e2e/config/mechanisms_stellar.json",
      "specs/extensions/bazaar.md",
    ]);
  });

  test("reads every file at once after the pin, under one deadline", async () => {
    const h = harness(same);
    const signals = new Set<AbortSignal>();
    let open = 0;
    let most = 0;
    const read = h.deps.fetchText;
    await runUpstream({
      ...h.deps,
      fetchText: async (url, signal) => {
        signals.add(signal);
        open++;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 1));
        open--;
        return read(url);
      },
    });
    expect(most).toBe(FILES.length * 2);
    expect(signals.size).toBe(1);
  });

  test("throws and publishes nothing when the pin file names no single commit", async () => {
    for (const pinFile of [
      "no commit here",
      `${PIN_FILE}${PIN_FILE.replace(PIN, "a".repeat(40))}`,
    ]) {
      const h = harness(same, pinFile);
      await expect(runUpstream(h.deps)).rejects.toThrow(/one commit/);
      expect(h.published).toEqual([]);
    }
  });

  test("throws and publishes nothing when a file can't be read", async () => {
    const h = harness({ [FILES[0]!]: { pin: "v1", main: "v1" } });
    await expect(runUpstream(h.deps)).rejects.toThrow(/no fake/);
    expect(h.published).toEqual([]);
  });
});

describe("fetchText", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("names the file when the request fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    await expect(fetchText(OUR_PIN_URL, AbortSignal.timeout(1000))).rejects.toThrow(
      `${OUR_PIN_URL}: The operation was aborted due to timeout`,
    );
  });
});

describe("isUpstreamRun", () => {
  test("is the run at 08:00 UTC only, once a day", () => {
    expect(isUpstreamRun(new Date("2026-11-06T08:00:00Z"))).toBe(true);
    expect(isUpstreamRun(new Date("2026-11-06T08:05:00Z"))).toBe(false);
    expect(isUpstreamRun(new Date("2026-11-06T09:00:00Z"))).toBe(false);
  });
});
