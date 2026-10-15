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
  const passed = results.filter((result) => result.passed).length;
  return { summary: { total: results.length, passed, failed: results.length - passed }, results };
}

describe("judge", () => {
  it("passes a run where every scenario settled with a hash", () => {
    expect(judge(suiteRun([settled, { ...settled, testNumber: 2 }]))).toEqual([]);
  });

  it("fails when the suite wrote no file", () => {
    expect(judge(undefined)).toEqual([
      "the suite wrote no results: no scenario matched, or it stopped before running",
    ]);
  });

  it("fails a run with no scenarios", () => {
    expect(judge(suiteRun([]))).toEqual(["the suite ran no scenarios"]);
  });

  it("names each failed scenario with its error", () => {
    const failed = { ...settled, testNumber: 2, passed: false, error: "missing_facilitator" };
    expect(judge(suiteRun([settled, failed]))).toEqual([
      "#2 typescript/http/fetch -> typescript/http/express /exact/stellar failed: missing_facilitator",
    ]);
  });

  it("says so when a failed scenario gives no error", () => {
    const failed = { ...settled, passed: false };
    expect(judge(suiteRun([failed]))).toEqual([
      "#1 typescript/http/fetch -> typescript/http/express /exact/stellar failed: no error given",
    ]);
  });

  it("fails a passed scenario without a transaction hash", () => {
    expect(judge(suiteRun([{ ...settled, transaction: "" }]))).toEqual([
      "#1 typescript/http/fetch -> typescript/http/express /exact/stellar passed without a transaction hash",
    ]);
    expect(judge(suiteRun([{ ...settled, transaction: undefined }]))).toHaveLength(1);
  });

  it("lists every problem in scenario order, not only the first", () => {
    const noHash = { ...settled, testNumber: 2, transaction: "" };
    const failed = { ...settled, testNumber: 3, passed: false, error: "boom" };
    expect(judge(suiteRun([settled, noHash, failed]))).toEqual([
      "#2 typescript/http/fetch -> typescript/http/express /exact/stellar passed without a transaction hash",
      "#3 typescript/http/fetch -> typescript/http/express /exact/stellar failed: boom",
    ]);
  });
});
