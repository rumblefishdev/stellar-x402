// Fetches the model's files at its pinned revision into the directory given (the image's build).
// Usage: node scripts/fetch-model.mjs <dir>
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MODEL_FILES, MODEL_REPO, MODEL_REVISION } from "../dist/model.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: fetch-model.mjs <dir>");
await mkdir(dir, { recursive: true });
for (const file of MODEL_FILES) {
  const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  await writeFile(join(dir, file), Buffer.from(await response.arrayBuffer()));
}
