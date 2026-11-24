import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { InferenceSession, Tensor } from "onnxruntime-node";

/** The model's width: each vector has this many numbers (ADR 0014). */
const DIMS = 384;
/** ADR 0014 cuts the text a listing or a query is embedded from at 2,000 characters. */
const MAX_CHARS = 2_000;
/** The model reads at most 512 tokens (its `max_position_embeddings` is 514, two are reserved). */
const MAX_TOKENS = 512;

/** The text's first 2,000 characters, counted as Unicode code points so a cut never splits one. */
export function cutText(text: string): string {
  return Array.from(text).slice(0, MAX_CHARS).join("");
}

/** At most 512 tokens: a longer text keeps its first 511 and its closing token. */
export function cutTokens(ids: number[]): number[] {
  if (ids.length <= MAX_TOKENS) return ids;
  return [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]!];
}

/**
 * The text's vector from the model's output: the first token's row (granite pools by CLS,
 * `1_Pooling/config.json`), scaled to unit length so cosine similarity is a dot product.
 */
export function clsVector(hidden: Float32Array, dims: number): Float32Array {
  const vector = hidden.slice(0, dims);
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

/** Loads the model from `modelDir` and returns the function that embeds one text. */
export async function loadModel(modelDir: string): Promise<(text: string) => Promise<number[]>> {
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(join(modelDir, "tokenizer.json"), "utf8")),
    JSON.parse(await readFile(join(modelDir, "tokenizer_config.json"), "utf8")),
  );
  // One thread: the container has one CPU (ADR 0011) and embeds one text at a time.
  const session = await InferenceSession.create(join(modelDir, "model.onnx"), {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  return async (text) => {
    const ids = cutTokens(tokenizer.encode(cutText(text)).ids);
    const shape = [1, ids.length];
    const output = await session.run({
      input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
      attention_mask: new Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
    });
    const hidden = output[session.outputNames[0]!]!.data as Float32Array;
    return Array.from(clsVector(hidden, DIMS));
  };
}
