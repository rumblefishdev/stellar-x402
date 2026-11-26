import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MODEL_FILES } from "../src/model.js";

const run = promisify(execFile);
const script = new URL("../scripts/fetch-model.mjs", import.meta.url).pathname;
const wrongBytes = new URL("./fixtures/wrong-bytes.mjs", import.meta.url).pathname;

describe("fetch-model.mjs (0120 C: the image holds only the pinned model's files)", () => {
  it("fails and writes no file when the bytes fetched are not the ones model.ts names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fetch-model-"));
    const fetching = run(process.execPath, ["--import", wrongBytes, script, dir]);
    await expect(fetching).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`model.ts expects ${MODEL_FILES["model.onnx"]}`),
    });
    expect(await readdir(dir)).toEqual([]);
  });
});
