import { describe, expect, it } from "vitest";
import { clsVector, cutText, cutTokens } from "../src/embed.js";

/** The L2 norm of a vector. */
const norm = (vector: ArrayLike<number>) =>
  Math.sqrt(Array.from(vector).reduce((sum, value) => sum + value * value, 0));

describe("cutText (0120 C, B: the text is cut at 2,000 characters)", () => {
  it.each([
    ["an empty text", ""],
    ["a short text", "weather in Kraków"],
    ["a text of 2,000 characters", "a".repeat(2_000)],
  ])("keeps %s as it is", (_name, text) => {
    expect(cutText(text)).toBe(text);
  });

  it.each([
    ["2,001 characters", 2_001],
    ["10,000 characters", 10_000],
  ])("cuts a text of %s to its first 2,000", (_name, length) => {
    const text = Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    expect(cutText(text)).toBe(text.slice(0, 2_000));
  });

  it("never splits a character made of two UTF-16 units at the cut", () => {
    const text = `${"a".repeat(1_999)}😀b`;
    const cut = cutText(text);
    expect(cut).toBe(`${"a".repeat(1_999)}😀`);
  });
});

describe("cutTokens (0120 C: at most 512 tokens, the closing one kept)", () => {
  const ids = (length: number) =>
    Array.from({ length }, (_, i) => (i === length - 1 ? 102 : 1_000 + i));

  it.each([0, 1, 511, 512])("keeps %i tokens as they are", (length) => {
    expect(cutTokens(ids(length))).toEqual(ids(length));
  });

  it.each([513, 600, 5_000])("cuts %i tokens to the first 511 and the closing one", (length) => {
    const all = ids(length);
    const cut = cutTokens(all);
    expect(cut).toHaveLength(512);
    expect(cut.slice(0, 511)).toEqual(all.slice(0, 511));
    expect(cut[511]).toBe(102);
  });

  it("leaves the tokens it was given as they were", () => {
    const all = ids(600);
    const copy = [...all];
    cutTokens(all);
    expect(all).toEqual(copy);
  });
});

describe("clsVector (0120 C: the first token's row, normalized)", () => {
  it("takes the first row and normalizes it", () => {
    const hidden = Float32Array.from([3, 4, 9, 9, 1, 1]);
    const vector = clsVector(hidden, 2);
    expect(vector).toBeInstanceOf(Float32Array);
    expect(Array.from(vector)).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)]);
  });

  it("gives 384 numbers of unit length from a model-sized output, read from the first row only", () => {
    const dims = 384;
    const rows = 7;
    let seed = 42;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    const hidden = Float32Array.from({ length: dims * rows }, random);
    const vector = clsVector(hidden, dims);
    expect(vector).toHaveLength(dims);
    expect(Math.abs(norm(vector) - 1)).toBeLessThanOrEqual(1e-5);
    const first = hidden.slice(0, dims);
    const firstNorm = norm(first);
    for (let i = 0; i < dims; i++) expect(vector[i]).toBeCloseTo(first[i]! / firstNorm, 5);
    // Another row's values change nothing.
    const other = Float32Array.from(hidden);
    other.fill(5, dims);
    expect(Array.from(clsVector(other, dims))).toEqual(Array.from(vector));
  });

  it("leaves the model's output as it was", () => {
    const hidden = Float32Array.from([3, 4, 9, 9]);
    clsVector(hidden, 2);
    expect(Array.from(hidden)).toEqual([3, 4, 9, 9]);
  });
});
