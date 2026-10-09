import { describe, expect, it } from "vitest";
import { canonicalizeUrl, catalogKey, sanitizeIconUrl } from "../src/index.js";

const base = {
  network: "stellar:testnet",
  payTo: "GPAYTO",
  type: "http" as const,
  method: "GET",
};

describe("canonicalizeUrl", () => {
  it.each([
    // G10: one canonical form per case
    ["https://API.Example.COM/users", "https://api.example.com/users"],
    ["https://api.example.com:443/users", "https://api.example.com/users"],
    ["https://api.example.com:8443/users", "https://api.example.com:8443/users"],
    ["https://api.example.com/a/./b/../c", "https://api.example.com/a/c"],
    ["https://api.example.com/%7Euser", "https://api.example.com/~user"],
    ["https://api.example.com/a%2fb", "https://api.example.com/a%2Fb"],
    ["https://api.example.com/x?id=1#top", "https://api.example.com/x"],
    ["https://api.example.com/Users/", "https://api.example.com/Users/"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it("keeps path case and the trailing slash apart", () => {
    expect(canonicalizeUrl("https://x.com/a")).not.toBe(canonicalizeUrl("https://x.com/a/"));
    expect(canonicalizeUrl("https://x.com/A")).not.toBe(canonicalizeUrl("https://x.com/a"));
  });

  it.each([
    // G8: schemes, IPs, loopback, userinfo
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://api.example.com/x",
    "https://127.0.0.1/x",
    "https://2130706433/x",
    "https://0x7f000001/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://foo.localhost/x",
    "https://api.example.com./x",
    "https://user:pass@api.example.com/x",
    "https://api.example.com//x",
    "not a url",
    "",
    `https://api.example.com/${"a".repeat(2048)}`,
  ])("rejects %s", (input) => {
    expect(canonicalizeUrl(input)).toBeUndefined();
  });
});

describe("catalogKey", () => {
  const key = (resourceUrl: string, routeTemplate?: string) =>
    catalogKey({ ...base, resourceUrl, routeTemplate })?.resourceUrl;

  it("gives /users/42 and /users/7 one key under /users/:userId", () => {
    const a = catalogKey({
      ...base,
      resourceUrl: "https://x.com/users/42",
      routeTemplate: "/users/:userId",
    });
    const b = catalogKey({
      ...base,
      resourceUrl: "https://x.com/users/7",
      routeTemplate: "/users/:userId",
    });
    expect(a).toEqual(b);
    expect(a).toEqual({
      network: "stellar:testnet",
      payTo: "GPAYTO",
      method: "GET",
      resourceUrl: "https://x.com/users/:",
    });
  });

  it("erases parameter names (RT3)", () => {
    expect(key("https://x.com/users/42", "/users/:id")).toBe(
      key("https://x.com/users/42", "/users/:userId"),
    );
  });

  it("keeps /a and /a/ apart, and merges query and fragment variants", () => {
    expect(key("https://x.com/a")).not.toBe(key("https://x.com/a/"));
    expect(key("https://x.com/a?x=1")).toBe(key("https://x.com/a#frag"));
  });

  it.each([
    // G4: a template that doesn't match the paid path is ignored
    ["https://x.com/orders/5", "/users/:id", "https://x.com/orders/5"],
    ["https://x.com/cheap", "/premium", "https://x.com/cheap"],
    // no static segment
    ["https://x.com/42", "/:id", "https://x.com/42"],
    // G6: grammar failures fall back to the concrete path
    ["https://x.com/a/b", "//evil.com", "https://x.com/a/b"],
    ["https://x.com/a/b", "/a%2Fb", "https://x.com/a/b"],
    ["https://x.com/a/b", "/a/b%00", "https://x.com/a/b"],
    ["https://x.com/a/b", "/a/b\r\n", "https://x.com/a/b"],
    ["https://x.com/a/b", "/a/‮b", "https://x.com/a/b"],
    ["https://x.com/a/x", "/a/:", "https://x.com/a/x"],
    ["https://x.com/a/x", "/a/:1abc", "https://x.com/a/x"],
    ["https://x.com/a/x", `/a/:${"p".repeat(254)}`, "https://x.com/a/x"],
    ["https://x.com/a/x", "/a/../x", "https://x.com/a/x"],
  ])("%s with template %j keys as %s", (url, template, expected) => {
    expect(key(url, template)).toBe(expected);
  });

  it("uses the tool name as the method for mcp and ignores the template (G5)", () => {
    expect(
      catalogKey({
        ...base,
        type: "mcp",
        toolName: "a",
        resourceUrl: "https://x.com/mcp/1",
        routeTemplate: "/mcp/:id",
      }),
    ).toEqual({
      network: "stellar:testnet",
      payTo: "GPAYTO",
      method: "a",
      resourceUrl: "https://x.com/mcp/1",
    });
  });

  it("gives two tools on one URL two keys", () => {
    const tool = (toolName: string) =>
      catalogKey({ ...base, type: "mcp", toolName, resourceUrl: "https://x.com/mcp" });
    expect(tool("a")).not.toEqual(tool("b"));
  });

  it("returns undefined when the input can't be cataloged", () => {
    expect(catalogKey({ ...base, resourceUrl: "http://x.com/a" })).toBeUndefined();
    expect(
      catalogKey({ ...base, method: undefined, resourceUrl: "https://x.com/a" }),
    ).toBeUndefined();
  });
});

describe("sanitizeIconUrl (G7)", () => {
  it("stores the canonical href", () => {
    expect(sanitizeIconUrl("https://CDN.example.com:443/i.png")).toBe(
      "https://cdn.example.com/i.png",
    );
  });

  it.each([
    "https://localhost./i.png",
    "https://foo.localhost/i.png",
    "https://example.com\\@127.0.0.1/i.png",
    "http://cdn.example.com/i.png",
    "https://127.0.0.1/i.png",
    "data:image/png;base64,AAAA",
  ])("drops %s", (input) => {
    expect(sanitizeIconUrl(input)).toBeUndefined();
  });
});
