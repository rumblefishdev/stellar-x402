// @vitest-environment node
import { expect, it } from "vitest";
import { tokenize } from "../src/components/Code";

const join = (source: string, language: "js" | "json", mark?: string[]) =>
  tokenize(source, language, mark)
    .map((token) => token.text)
    .join("");

it("keeps a snippet's text as it was written", () => {
  const js = 'const a = `Bearer ${key}`; // from "x"\nawait pay("https://a.example/b");\n';
  const json = '// POST /settle\n{\n  "success": true,\n  "payer": "G…BUYER"\n}';
  expect(join(js, "js")).toBe(js);
  expect(join(json, "json")).toBe(json);
});

it("colours keywords, strings and comments, and a keyword inside either as its part", () => {
  expect(tokenize('import a from "from"; // new', "js")).toEqual([
    { text: "import", kind: "keyword" },
    { text: " a " },
    { text: "from", kind: "keyword" },
    { text: " " },
    { text: '"from"', kind: "string" },
    { text: "; " },
    { text: "// new", kind: "comment" },
  ]);
});

it("marks the strings it is asked to", () => {
  const tokens = tokenize('url: "https://f.example", other: "x"', "js", ['"https://f.example"']);
  expect(tokens.filter((token) => token.kind === "mark").map((token) => token.text)).toEqual([
    '"https://f.example"',
  ]);
});

it("marks a JSON key and leaves its value", () => {
  expect(tokenize('{ "network": "stellar:pubnet" }', "json")).toEqual([
    { text: "{ " },
    { text: '"network"', kind: "mark" },
    { text: ': "stellar:pubnet" }' },
  ]);
});
