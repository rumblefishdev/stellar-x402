/**
 * Cases ported from the upstream TS bazaar suite (x402-foundation/x402@7f2b2f1), run through our
 * wrapper, so we stay in line with the TS, Python and Go implementations.
 */
import { describe, expect, it } from "vitest";
import { catalogKey, sanitizeIconUrl, validate } from "../src/index.js";
import { payload, requirements } from "./fixtures.js";

const metadata = (resource: Record<string, unknown>) => {
  const result = validate(payload({ resource }), requirements);
  if (!result?.ok) throw new Error("expected ok");
  return result.discovered;
};

describe("iconUrl (upstream isValidIconUrl cases)", () => {
  it.each([
    "https://10.0.0.1/i.png",
    "https://192.168.1.1/i.png",
    "https://169.254.169.254/i.png",
    "https://0177.0.0.1/i.png",
    "https://0x7f.0.0.1/i.png",
    "https://017700000001/i.png",
    "https://[::ffff:127.0.0.1]/i.png",
    "https://localhost.localdomain/i.png",
    "https://ip6-localhost/i.png",
    "file:///etc/passwd",
    "data:image/png;base64,AAAA",
    "https://user:pass@cdn.example.com/i.png",
    "https://cdn.example.com/i\u0000.png",
    `https://cdn.example.com/${"a".repeat(2048)}`,
    "/relative/i.png",
  ])("drops %s", (iconUrl) => {
    expect(sanitizeIconUrl(iconUrl)).toBeUndefined();
    expect(metadata({ iconUrl }).iconUrl).toBeUndefined();
  });
});

describe("serviceName and tags (upstream soft-drop rules)", () => {
  it("keeps a 32-character printable serviceName and drops 33 characters or non-ASCII", () => {
    expect(metadata({ serviceName: "s".repeat(32) }).serviceName).toBe("s".repeat(32));
    expect(metadata({ serviceName: "s".repeat(33) }).serviceName).toBeUndefined();
    expect(metadata({ serviceName: "Café" }).serviceName).toBeUndefined();
  });

  it("keeps at most 5 tags of up to 32 characters, deduplicated case-insensitively", () => {
    const tags = metadata({ tags: ["a", "A", "b", "c", "d", "e", "f", "t".repeat(33)] }).tags;
    expect(tags).toHaveLength(5);
    expect(tags?.map((tag) => tag.toLowerCase())).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("routeTemplate traversal (upstream fixes for #3169)", () => {
  const key = (url: string, routeTemplate: string) =>
    catalogKey({
      network: "stellar:testnet",
      payTo: "GPAYTO",
      type: "http",
      method: "GET",
      resourceUrl: url,
      routeTemplate,
    })?.resourceUrl;

  it.each([
    "/users/../admin",
    "/users/%2e%2e/admin",
    "/users/%252e%252e/admin",
    "/users/http://evil.com",
  ])("falls back to the concrete path for %s", (routeTemplate) => {
    expect(key("https://x.com/users/1/admin", routeTemplate)).toBe("https://x.com/users/1/admin");
  });
});
