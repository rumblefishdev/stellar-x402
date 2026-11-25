// Fetches the model's files at its pinned revision into the directory given (the image's build),
// and writes each one only when its bytes have the SHA-256 that model.ts names.
// Usage: node scripts/fetch-model.mjs <dir>
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MODEL_FILES, MODEL_REPO, MODEL_REVISION } from "../dist/model.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: fetch-model.mjs <dir>");
await mkdir(dir, { recursive: true });
for (const [file, expected] of Object.entries(MODEL_FILES)) {
  const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`${file}: SHA-256 ${actual}, model.ts expects ${expected}`);
  }
  await writeFile(join(dir, file), bytes);
}
