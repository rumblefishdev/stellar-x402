// @vitest-environment node
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";
import { BASE_PATH } from "../src/base-path";

const root = fileURLToPath(new URL("..", import.meta.url));

const built = async () => {
  const result = await build({ root, logLevel: "silent", build: { write: false } });
  return (Array.isArray(result) ? result : [result]).flatMap((part) =>
    "output" in part ? part.output : [],
  );
};
const text = (file: Awaited<ReturnType<typeof built>>[number]) =>
  file.type === "asset" ? String(file.source) : file.code;

it("builds a page that asks for its files under the prefix it is served from", async () => {
  const page = (await built()).find((file) => file.fileName === "index.html");
  if (!page) throw new Error("the build has no index.html");

  const urls = [...text(page).matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) expect(url).toMatch(new RegExp(`^${BASE_PATH}assets/`));
});

it("ships its fonts, and asks no other host for one", async () => {
  const output = await built();
  expect(output.some((file) => file.fileName.endsWith(".woff2"))).toBe(true);
  for (const file of output.filter((file) => /\.(html|css)$/.test(file.fileName))) {
    expect(text(file)).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
    expect(text(file)).not.toContain("fonts.googleapis.com");
  }
});
