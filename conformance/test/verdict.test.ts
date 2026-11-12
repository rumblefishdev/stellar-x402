import { describe, expect, it } from "vitest";
import { judge, resultsFolder, type RunRecord, type SuiteResult } from "../src/verdict.js";

const settled: SuiteResult = {
  testNumber: 1,
  client: "typescript/http/fetch",
  server: "typescript/http/express",
  endpoint: "/exact/stellar",
  passed: true,
  transaction: "4f1c0b7e",
};

function suiteRun(results: SuiteResult[]) {
  return { results };
}

/** A facilitator that names its commit, judged by committed gate code. */
const clean: RunRecord = { facilitatorCommit: "5d2e26ba", gateChanges: "" };

describe("judge", () => {
  it("passes a run where every scenario settled with a hash", () => {
    const second = { ...settled, testNumber: 2, transaction: "9a2e51c0" };
    expect(judge(suiteRun([settled, second]), 0, clean)).toEqual([]);
  });

  it("fails a run the suite exited non-zero, even when every scenario passed", () => {
    expect(judge(suiteRun([settled]), 1, clean)).toEqual(["the suite exited with 1"]);
  });

  it("fails a run the suite was killed in", () => {
    expect(judge(suiteRun([settled]), null, clean)).toEqual(["the suite exited with null"]);
  });

  it("names both the exit and the missing file", () => {
    expect(judge(undefined, 1, clean)).toEqual([
      "the suite exited with 1",
      "the suite wrote no results: no scenario matched, or it stopped before running",
    ]);
  });

  it("fails when the suite wrote no file", () => {
    expect(judge(undefined, 0, clean)).toEqual([
      "the suite wrote no results: no scenario matched, or it stopped before running",
    ]);
  });

  it("fails a run with no scenarios", () => {
    expect(judge(suiteRun([]), 0, clean)).toEqual(["the suite ran no scenarios"]);
  });

  it("names each failed scenario with its error", () => {
    const failed = { ...settled, testNumber: 2, passed: false, error: "missing_facilitator" };
    expect(judge(suiteRun([settled, failed]), 0, clean)).toEqual([
      "#2 typescript/http/fetch -> typescript/http/express /exact/stellar failed: missing_facilitator",
    ]);
  });

  it("says so when a failed scenario gives no error", () => {
    const failed = { ...settled, passed: false };
    expect(judge(suiteRun([failed]), 0, clean)).toEqual([
      "#1 typescript/http/fetch -> typescript/http/express /exact/stellar failed: no error given",
    ]);
  });

  it("fails a passed scenario without a transaction hash", () => {
    expect(judge(suiteRun([{ ...settled, transaction: "" }]), 0, clean)).toEqual([
      "#1 typescript/http/fetch -> typescript/http/express /exact/stellar passed without a transaction hash",
    ]);
    expect(judge(suiteRun([{ ...settled, transaction: undefined }]), 0, clean)).toHaveLength(1);
  });

  it("fails a hash that more than one scenario reports", () => {
    const again = { ...settled, testNumber: 2, endpoint: "/exact/stellar/upfront" };
    expect(judge(suiteRun([settled, again]), 0, clean)).toEqual([
      "#2 typescript/http/fetch -> typescript/http/express /exact/stellar/upfront reports transaction 4f1c0b7e, as #1 does",
    ]);
  });

  it("lists every problem in scenario order, not only the first", () => {
    const noHash = { ...settled, testNumber: 2, transaction: "" };
    const failed = { ...settled, testNumber: 3, passed: false, error: "boom" };
    expect(judge(suiteRun([settled, noHash, failed]), 0, clean)).toEqual([
      "#2 typescript/http/fetch -> typescript/http/express /exact/stellar passed without a transaction hash",
      "#3 typescript/http/fetch -> typescript/http/express /exact/stellar failed: boom",
    ]);
  });
});

describe("judge, the run's record", () => {
  it("fails a run whose facilitator names no commit", () => {
    expect(judge(suiteRun([settled]), 0, { ...clean, facilitatorCommit: null })).toEqual([
      "the facilitator names no commit on /health",
    ]);
    expect(judge(suiteRun([settled]), 0, { ...clean, facilitatorCommit: "" })).toHaveLength(1);
  });

  it("fails a run judged by gate code that isn't committed, naming the files", () => {
    const gateChanges = " M src/verdict.ts\n?? external-proxy/extra.mjs";
    expect(judge(suiteRun([settled]), 0, { ...clean, gateChanges })).toEqual([
      `the gate has uncommitted changes:\n${gateChanges}`,
    ]);
  });

  it("names both after the suite's own problems, also when the suite wrote no file", () => {
    const record = { facilitatorCommit: null, gateChanges: " M src/gate.ts" };
    expect(judge(undefined, 1, record)).toEqual([
      "the suite exited with 1",
      "the suite wrote no results: no scenario matched, or it stopped before running",
      "the facilitator names no commit on /health",
      "the gate has uncommitted changes:\n M src/gate.ts",
    ]);
  });
});

describe("resultsFolder", () => {
  it.each([
    "http://localhost:4022",
    "http://127.0.0.1:4022",
    "http://[::1]:4022",
    "http://LOCALHOST:4022/",
  ])("keeps a run against %s out of git, as local", (url) => {
    expect(resultsFolder(url)).toBe("testnet-local");
  });

  it.each([
    "https://facilitator.example.org",
    "http://192.168.1.20:4022",
    "https://localhost.example.org",
  ])("files a run against %s as hosted", (url) => {
    expect(resultsFolder(url)).toBe("testnet-hosted");
  });
});
