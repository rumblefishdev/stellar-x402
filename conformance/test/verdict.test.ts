import { describe, expect, it } from "vitest";
import { judge, type SuiteResult } from "../src/verdict.js";

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

describe("judge", () => {
  it("passes a run where every scenario settled with a hash", () => {
    const second = { ...settled, testNumber: 2, transaction: "9a2e51c0" };
    expect(judge(suiteRun([settled, second]), 0)).toEqual([]);
  });

  it("fails a run the suite exited non-zero, even when every scenario passed", () => {
    expect(judge(suiteRun([settled]), 1)).toEqual(["the suite exited with 1"]);
  });

  it("fails a run the suite was killed in", () => {
    expect(judge(suiteRun([settled]), null)).toEqual(["the suite exited with null"]);
  });

  it("names both the exit and the missing file", () => {
    expect(judge(undefined, 1)).toEqual([
      "the suite exited with 1",
      "the suite wrote no results: no scenario matched, or it stopped before running",
    ]);
  });

  it("fails when the suite wrote no file", () => {
    expect(judge(undefined, 0)).toEqual([
      "the suite wrote no results: no scenario matched, or it stopped before running",
    ]);
  });

  it("fails a run with no scenarios", () => {
    expect(judge(suiteRun([]), 0)).toEqual(["the suite ran no scenarios"]);
  });

  it("names each failed scenario with its error", () => {
    const failed = { ...settled, testNumber: 2, passed: false, error: "missing_facilitator" };
    expect(judge(suiteRun([settled, failed]), 0)).toEqual([
      "#2 typescript/http/fetch -> typescript/http/express /exact/stellar failed: missing_facilitator",
    ]);
  });

  it("says so when a failed scenario gives no error", () => {
    const failed = { ...settled, passed: false };
    expect(judge(suiteRun([failed]), 0)).toEqual([
      "#1 typescript/http/fetch -> typescript/http/express /exact/stellar failed: no error given",
    ]);
  });

  it("fails a passed scenario without a transaction hash", () => {
    expect(judge(suiteRun([{ ...settled, transaction: "" }]), 0)).toEqual([
      "#1 typescript/http/fetch -> typescript/http/express /exact/stellar passed without a transaction hash",
    ]);
    expect(judge(suiteRun([{ ...settled, transaction: undefined }]), 0)).toHaveLength(1);
  });

  it("fails a hash that more than one scenario reports", () => {
    const again = { ...settled, testNumber: 2, endpoint: "/exact/stellar/upfront" };
    expect(judge(suiteRun([settled, again]), 0)).toEqual([
      "#2 typescript/http/fetch -> typescript/http/express /exact/stellar/upfront reports transaction 4f1c0b7e, as #1 does",
    ]);
  });

  it("lists every problem in scenario order, not only the first", () => {
    const noHash = { ...settled, testNumber: 2, transaction: "" };
    const failed = { ...settled, testNumber: 3, passed: false, error: "boom" };
    expect(judge(suiteRun([settled, noHash, failed]), 0)).toEqual([
      "#2 typescript/http/fetch -> typescript/http/express /exact/stellar passed without a transaction hash",
      "#3 typescript/http/fetch -> typescript/http/express /exact/stellar failed: boom",
    ]);
  });
});
