import { seriesDims } from "@stellar-x402/metrics-catalog";
import { describe, expect, test } from "vitest";
import type { PutMetricDataInput } from "../src/watch/balance.js";
import { LIBRARY_METRIC, NPM_LATEST_URL, PACKAGE_PATH, runLibrary } from "../src/watch/library.js";
import { OUR_RAW } from "../src/watch/upstream.js";
import { NAMESPACE } from "../src/watch/metric.js";

const HEALTH = "https://x402-facilitator.sorobanscan.com/health";
const COMMIT = "5d2e26ba141747db0713efd9e4b2dfd1b2510f69";
const AT = new Date("2026-11-16T08:00:00Z");

const health = (commit?: string) =>
  JSON.stringify({ ready: true, signer: "ok", listed: true, ...(commit ? { commit } : {}) });
const packageJson = (range: string) =>
  JSON.stringify({ dependencies: { "@x402/core": range, "@x402/stellar": range } });

/** Production, GitHub and npm as the answers say; a missing answer throws as fetchText does. */
function harness(answers: Record<string, string>) {
  const published: PutMetricDataInput[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps = {
    healthUrl: HEALTH,
    fetchText: async (url: string) => {
      const answer = answers[url];
      if (answer === undefined) throw new Error(`${url} answered 404`);
      return answer;
    },
    publish: async (input: PutMetricDataInput) => {
      published.push(input);
    },
    log: (line: Record<string, unknown>) => logs.push(line),
    at: AT,
  };
  return { deps, published, logs };
}

/** Today's answers: production on 5d2e26ba asks for ~2.28.0, npm's latest is 2.31.0. */
const today = {
  [HEALTH]: health(COMMIT),
  [`${OUR_RAW}/${COMMIT}/${PACKAGE_PATH}`]: packageJson("~2.28.0"),
  [NPM_LATEST_URL]: JSON.stringify({ name: "@x402/stellar", version: "2.31.0" }),
};

describe("the library metric", () => {
  test("is the catalog's upstream_library_behind, with no dimension", () => {
    expect(seriesDims(LIBRARY_METRIC, {})).toEqual({ ok: true, namespace: NAMESPACE });
  });
});

describe("runLibrary", () => {
  test("publishes 1 when production asks for another @x402/stellar than npm's latest", async () => {
    const h = harness(today);
    await runLibrary(h.deps);
    expect(h.published).toEqual([
      {
        Namespace: NAMESPACE,
        MetricData: [
          { MetricName: LIBRARY_METRIC, Dimensions: [], Value: 1, Unit: "Count", Timestamp: AT },
        ],
      },
    ]);
    expect(h.logs).toContainEqual({
      msg: "watch_library",
      commit: COMMIT,
      production: "2.28.0",
      latest: "2.31.0",
    });
  });

  test("publishes 0 when production asks for npm's latest", async () => {
    const h = harness({
      ...today,
      [`${OUR_RAW}/${COMMIT}/${PACKAGE_PATH}`]: packageJson("~2.31.0"),
    });
    await runLibrary(h.deps);
    expect(h.published[0]?.MetricData[0]?.Value).toBe(0);
  });

  test.each([
    ["a /health that names no commit", { [HEALTH]: health() }, /names no commit/],
    [
      "a range in another shape than ~X.Y.Z",
      { [`${OUR_RAW}/${COMMIT}/${PACKAGE_PATH}`]: packageJson("^2.31.0") },
      /\^2\.31\.0/,
    ],
    ["npm down", { [NPM_LATEST_URL]: undefined }, /404/],
    [
      "a page in place of /health's JSON",
      { [HEALTH]: "<html>challenge</html>" },
      /x402-facilitator\.sorobanscan\.com\/health answered no JSON/,
    ],
    ["GitHub without the file", { [`${OUR_RAW}/${COMMIT}/${PACKAGE_PATH}`]: undefined }, /404/],
  ] as const)("publishes nothing and fails loudly on %s", async (_, change, error) => {
    const answers = { ...today, ...change } as Record<string, string | undefined>;
    for (const [url, answer] of Object.entries(answers))
      if (answer === undefined) delete answers[url];
    const h = harness(answers as Record<string, string>);
    await expect(runLibrary(h.deps)).rejects.toThrow(error);
    expect(h.published).toEqual([]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ msg: "watch_section_failed", section: "library" }),
    );
  });
});
