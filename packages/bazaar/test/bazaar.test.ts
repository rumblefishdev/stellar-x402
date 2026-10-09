import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { normalize, toExtensionResponses, validate } from "../src/index.js";

const req = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CASSET",
  amount: "10000",
  payTo: "GPAYTO",
  maxTimeoutSeconds: 60,
  extra: {},
} as PaymentRequirements;

const http = { input: { type: "http", method: "GET" } };
const mcp = { input: { type: "mcp", toolName: "weather", inputSchema: {} } };

function pay(url: unknown, bazaar: unknown, resource: object = {}, x402Version = 2) {
  return {
    x402Version,
    resource: { url, ...resource },
    extensions: { bazaar },
  } as unknown as PaymentPayload;
}

const reason = (p: PaymentPayload) => {
  const r = validate(p, req);
  return r?.ok ? "ok" : r?.reason;
};

function entry(p: PaymentPayload) {
  const r = validate(p, req);
  if (!r?.ok) throw new Error(JSON.stringify(r));
  return normalize(r, req);
}

function deep(n: number): unknown {
  let value: unknown = "x";
  for (let i = 0; i < n; i++) value = [value];
  return value;
}

describe("packages/bazaar", () => {
  it("normalizes http and mcp listings, keyed with the verified network and payTo", () => {
    expect(entry(pay("https://API.x.com:443/a?q=1", { info: http })).key).toEqual({
      network: "stellar:testnet",
      payTo: "GPAYTO",
      method: "GET",
      resourceUrl: "https://api.x.com/a",
    });
    expect(entry(pay("https://x.com/mcp", { info: mcp })).key.method).toBe("weather");
  });

  it("gives /users/42 and /users/7 one key under /users/:userId, and erases param names", () => {
    const a = entry(pay("https://x.com/users/42", { info: http, routeTemplate: "/users/:userId" }));
    const b = entry(pay("https://x.com/users/7", { info: http, routeTemplate: "/users/:id" }));
    expect(a.key).toEqual(b.key);
    expect(a.key.resourceUrl).toBe("https://x.com/users/:");
  });

  it("stores the paid path when the template doesn't match it (G4)", () => {
    const e = entry(pay("https://x.com/cheap", { info: http, routeTemplate: "/premium" }));
    expect([e.key.resourceUrl, e.resource.resource]).toEqual([
      "https://x.com/cheap",
      "https://x.com/cheap",
    ]);
  });

  it.each([
    ["no bazaar info", pay("https://x.com/a", { schema: {} }), "invalid_info"],
    ["no info.input", pay("https://x.com/a", { info: {} }), "invalid_info"],
    [
      "http without method",
      pay("https://x.com/a", { info: { input: { type: "http" } } }),
      "invalid_info",
    ],
    [
      "method TRACE",
      pay("https://x.com/a", { info: { input: { type: "http", method: "TRACE" } } }),
      "invalid_info",
    ],
    ["non-object block", pay("https://x.com/a", "x"), "invalid_extension"],
    ["missing url", pay(undefined, { info: http }), "invalid_resource_url"],
    ["http url", pay("http://x.com/a", { info: http }), "invalid_resource_url"],
    ["IP host", pay("https://127.0.0.1/a", { info: http }), "invalid_resource_url"],
    ["localhost", pay("https://foo.localhost/a", { info: http }), "invalid_resource_url"],
    ["x402 v1", pay("https://x.com/a", { info: http }, {}, 1), "unsupported_version"],
    ["x402 v3", pay("https://x.com/a", { info: http }, {}, 3), "unsupported_version"],
    [
      "501-char description",
      pay("https://x.com/a", { info: http }, { description: "d".repeat(501) }),
      "too_large",
    ],
    ["deep schema", pay("https://x.com/a", { info: http, schema: deep(11) }), "schema_too_complex"],
    [
      "external $ref",
      pay("https://x.com/a", { info: http, schema: { $ref: "https://e.com/s" } }),
      "schema_too_complex",
    ],
    [
      "unserializably deep block (RT6)",
      pay("https://x.com/a", { info: http, schema: deep(100_000) }),
      "too_large",
    ],
  ])("rejects %s with its own reason, never internal_error", (_, p, expected) => {
    expect(reason(p)).toBe(expected);
  });

  it("returns undefined only when there is no bazaar key", () => {
    expect(
      validate({ x402Version: 2, extensions: {} } as unknown as PaymentPayload, req),
    ).toBeUndefined();
  });

  it("drops bad optional fields, keeps only https icons, and echoes only the bazaar block", () => {
    const p = pay(
      "https://x.com/a",
      { info: http },
      { serviceName: "s".repeat(33), iconUrl: "https://localhost./i.png" },
    );
    (p.extensions as Record<string, unknown>)["sign-in-with-x"] = { token: "secret" };
    const r = validate(p, req);
    expect(r?.ok && [r.discovered.serviceName, r.discovered.iconUrl]).toEqual([
      undefined,
      undefined,
    ]);
    expect(r?.ok && Object.keys(r.discovered.extensions ?? {})).toEqual(["bazaar"]);
    const icon = validate(
      pay("https://x.com/a", { info: http }, { iconUrl: "https://CDN.x.com/i.png" }),
      req,
    );
    expect(icon?.ok && icon.discovered.iconUrl).toBe("https://cdn.x.com/i.png");
  });

  it("builds the header without detail", () => {
    expect(toExtensionResponses(validate(pay("http://x.com/a", { info: http }), req)!)).toEqual({
      bazaar: { status: "rejected", rejectedReason: "invalid_resource_url" },
    });
  });

  it("accepts http only behind the allowHttp option", () => {
    expect(validate(pay("http://x.com/a", { info: http }), req, { allowHttp: true })?.ok).toBe(
      true,
    );
  });

  it("does no I/O, reads no env or clock, and compiles no schema", () => {
    const src = join(import.meta.dirname, "../src");
    for (const file of readdirSync(src)) {
      const code = readFileSync(join(src, file), "utf8");
      expect(code).not.toMatch(/from "node:|(?<![\w-])process\.|\bDate\b|\bfetch\(|\bcompile\(/);
    }
  });
});
