import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  normalize,
  toExtensionResponses,
  validate,
  type ValidateOptions,
} from "../src/index.js";

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

/** `CATALOG_LIST_LOCAL`: what a facilitator run locally and the e2e gate list (0054). */
const LOCAL: ValidateOptions = { listLocal: true };

function entry(p: PaymentPayload, options: ValidateOptions = {}) {
  const r = validate(p, req, options);
  if (!r?.ok) throw new Error(JSON.stringify(r));
  return normalize(r, req);
}

function deep(n: number): unknown {
  let value: unknown = "x";
  for (let i = 0; i < n; i++) value = [value];
  return value;
}

type Case = [string, PaymentPayload, string];

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

  it("gives /users/42 and /users/7 one key and one listing, with param names erased", () => {
    const a = entry(pay("https://x.com/users/42", { info: http, routeTemplate: "/users/:userId" }));
    const b = entry(pay("https://x.com/users/7", { info: http, routeTemplate: "/users/:id" }));
    expect(a.key).toEqual(b.key);
    expect([a.key.resourceUrl, a.resource.resource]).toEqual([
      "https://x.com/users/:",
      "https://x.com/users/:",
    ]);
  });

  it("stores the paid path when the template doesn't match it (G4)", () => {
    const p = pay("https://x.com/cheap", { info: http, routeTemplate: "/premium" });
    expect(validate(p, req)).toMatchObject({ routeTemplateIgnored: true });
    const e = entry(p);
    expect([e.key.resourceUrl, e.resource.resource]).toEqual([
      "https://x.com/cheap",
      "https://x.com/cheap",
    ]);
  });

  it("treats an http body as example data, not a schema", () => {
    const body = { $ref: "order-42", pattern: "x".repeat(257) };
    const p = pay("https://x.com/a", {
      info: { input: { type: "http", method: "POST", bodyType: "json", body } },
    });
    expect(reason(p)).toBe("ok");
  });

  it("lists a schema as deep as real listings go (0083)", () => {
    // A real listing's answer, three objects deep: 11 levels with upstream's output wrapper.
    const answer = (inner: object) => ({ type: "object", properties: inner });
    const schema = {
      properties: {
        output: {
          properties: {
            example: answer({ data: answer({ chain: answer({ avg_block_time_ms: {} }) }) }),
          },
        },
      },
    };
    expect(reason(pay("https://x.com/a", { info: http, schema }))).toBe("ok");
    expect(reason(pay("https://x.com/a", { info: http, schema: deep(32) }))).toBe("ok");
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
    ...[
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://x.com/a",
      "ws://x.com/a",
    ].map((url) => [`scheme of ${url}`, pay(url, { info: http }), "invalid_resource_url"]),
    [
      "mcp: url on an http listing",
      pay("mcp://tool/weather", { info: http }),
      "invalid_resource_url",
    ],
    [
      "javascript: on an mcp listing",
      pay("javascript:alert(1)", { info: mcp }),
      "invalid_resource_url",
    ],
    ["userinfo", pay("http://u:p@localhost/a", { info: http }), "invalid_resource_url"],
    ["data: on an mcp listing", pay("data:text/html,x", { info: mcp }), "invalid_resource_url"],
    ["file: on an mcp listing", pay("file:///etc/passwd", { info: mcp }), "invalid_resource_url"],
    ["host ending in a dot", pay("https://x.com./a", { info: http }), "invalid_resource_url"],
    ["mcp: with a backslash", pay("mcp://tool/a\\b", { info: mcp }), "invalid_resource_url"],
    [
      "mcp: with a 64-character label",
      pay(`mcp://${"a".repeat(64)}/t`, { info: mcp }),
      "invalid_resource_url",
    ],
    [
      "mcp: host over 253 characters",
      pay(`mcp://${Array(5).fill("a".repeat(63)).join(".")}/t`, { info: mcp }),
      "invalid_resource_url",
    ],
    ["mcp: userinfo", pay("mcp://u:p@tool/x", { info: mcp }), "invalid_resource_url"],
    ["mcp: // in the path", pay("mcp://tool//x", { info: mcp }), "invalid_resource_url"],
    ["mimeType null", pay("https://x.com/a", { info: http }, { mimeType: null }), "invalid_info"],
    ["mimeType 0", pay("https://x.com/a", { info: http }, { mimeType: 0 }), "invalid_info"],
    ["mcp: without a host", pay("mcp:weather", { info: mcp }), "invalid_resource_url"],
    ["mcp: with an odd host", pay("mcp://to%20ol/weather", { info: mcp }), "invalid_resource_url"],
    [
      "mimeType of one space",
      pay("https://x.com/a", { info: http }, { mimeType: " " }),
      "invalid_info",
    ],
    ["mimeType json", pay("https://x.com/a", { info: http }, { mimeType: "json" }), "invalid_info"],
    ["x402 v1", pay("https://x.com/a", { info: http }, {}, 1), "unsupported_version"],
    ["x402 v3", pay("https://x.com/a", { info: http }, {}, 3), "unsupported_version"],
    [
      "501-char description",
      pay("https://x.com/a", { info: http }, { description: "d".repeat(501) }),
      "too_large",
    ],
    ["deep schema", pay("https://x.com/a", { info: http, schema: deep(33) }), "schema_too_complex"],
    [
      "external $ref",
      pay("https://x.com/a", { info: http, schema: { $ref: "https://e.com/s" } }),
      "schema_too_complex",
    ],
    [
      "100k-deep block, over the size cap (RT6)",
      pay("https://x.com/a", { info: http, schema: deep(100_000) }),
      "too_large",
    ],
    [
      "mcp inputSchema external $ref",
      pay("https://x.com/a", {
        info: { input: { ...mcp.input, inputSchema: { $ref: "https://e.com/s" } } },
      }),
      "schema_too_complex",
    ],
    [
      "percent-encoded self $ref",
      pay("https://x.com/a", {
        info: http,
        schema: { properties: { a: { $ref: "#/%70roperties" } } },
      }),
      "schema_too_complex",
    ],
    [
      "1,001 schema nodes",
      pay("https://x.com/a", { info: http, schema: { allOf: Array(1_000).fill(true) } }),
      "schema_too_complex",
    ],
    [
      "mimeType with CRLF",
      pay("https://x.com/a", { info: http }, { mimeType: 'text/plain; a="x\r\nSet-Cookie: s=1"' }),
      "invalid_info",
    ],
    [
      "mimeType without subtype",
      pay("https://x.com/a", { info: http }, { mimeType: "text" }),
      "invalid_info",
    ],
    [
      "description with NUL",
      pay("https://x.com/a", { info: http }, { description: "a\u0000b" }),
      "invalid_info",
    ],
  ] as Case[])("rejects %s with its own reason, never internal_error", (_, p, expected) => {
    expect(reason(p)).toBe(expected);
  });

  it("applies keyword rules to keywords only, not property names or enum data", () => {
    const schema = { properties: { $id: { type: "string" } }, enum: [{ $ref: "https://e.com/s" }] };
    expect(reason(pay("https://x.com/a", { info: http, schema }))).toBe("ok");
  });

  it.each([
    ["/a/%7Euser", undefined, "https://x.com/a/~user"],
    ["/users/42", "/users/..", "https://x.com/users/42"],
    ["/users/42", "/:a/:b", "https://x.com/users/42"],
  ])("keys %s with template %j as %s", (path, routeTemplate, expected) => {
    expect(entry(pay(`https://x.com${path}`, { info: http, routeTemplate })).key.resourceUrl).toBe(
      expected,
    );
  });

  it("caps tags at 5, drops icon fragments and icons that outgrow the URL limit", () => {
    const d = (resource: object) => {
      const r = validate(pay("https://x.com/a", { info: http }, resource), req);
      return r?.ok ? r.discovered : undefined;
    };
    expect(d({ tags: ["a", "b", "c", "d", "e", "f"] })?.tags).toHaveLength(5);
    expect(d({ iconUrl: "https://cdn.x.com/i.png#f" })?.iconUrl).toBe("https://cdn.x.com/i.png");
    expect(d({ iconUrl: `https://cdn.x.com/${" ".repeat(1_900)}x` })?.iconUrl).toBeUndefined();
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
    expect(
      toExtensionResponses(validate(pay("javascript:alert(1)", { info: http }), req)!),
    ).toEqual({
      bazaar: { status: "rejected", rejectedReason: "invalid_resource_url" },
    });
  });

  it('catalogs upstream defaults with listLocal: mimeType "", http, loopback, mcp://', () => {
    const local = entry(
      pay("http://localhost:4022/exact/stellar", { info: http }, { description: "", mimeType: "" }),
      LOCAL,
    );
    expect(local.key.resourceUrl).toBe("http://localhost:4022/exact/stellar");
    expect(local.resource.resource).toBe("http://localhost:4022/exact/stellar");
    expect(local.resource).not.toHaveProperty("mimeType");
    expect(local.resource).not.toHaveProperty("description");
    const tool = entry(
      pay("mcp://tool/get_weather", { info: mcp }, { mimeType: "application/json" }),
      LOCAL,
    );
    expect(tool.key).toMatchObject({ method: "weather", resourceUrl: "mcp://tool/get_weather" });
    expect(tool.resource.mimeType).toBe("application/json");
  });

  it.each([
    ["http://127.0.0.1:8080/a", "http://127.0.0.1:8080/a"],
    ["https://[::1]/a", "https://[::1]/a"],
    ["https://intranet/a?x=1#f", "https://intranet/a"],
    ["http://printer.local:80/a", "http://printer.local/a"],
    ["https://metadata.google.internal/a", "https://metadata.google.internal/a"],
  ])("keeps no host rules on resource URLs with listLocal: %s", (url, canonical) => {
    expect(entry(pay(url, { info: http }), LOCAL).key.resourceUrl).toBe(canonical);
  });

  it.each([
    ["mcp://TOOL/get_weather", "mcp://tool/get_weather"],
    ["MCP://tool/get_weather?x=1#f", "mcp://tool/get_weather"],
    ["mcp://tool/a/../get_%77eather", "mcp://tool/get_weather"],
    ["mcp://srv.example.com", "mcp://srv.example.com/"],
    ["mcp://srv.example.com/", "mcp://srv.example.com/"],
    ["mcp://tool:8080/weather", "mcp://tool:8080/weather"],
    ["mcp://tool/x?a=\\b", "mcp://tool/x"],
    ["http://localhost:4022/mcp", "http://localhost:4022/mcp"],
    ["https://x.com/mcp", "https://x.com/mcp"],
  ])("gives an mcp listing one canonical URL: %s", (url, canonical) => {
    expect(entry(pay(url, { info: mcp }), LOCAL).key.resourceUrl).toBe(canonical);
  });

  it("ignores a routeTemplate on an mcp listing and keys the tool URL", () => {
    const p = pay("mcp://tool/a", { info: mcp, routeTemplate: "/a" });
    expect(validate(p, req, LOCAL)).toMatchObject({ routeTemplateIgnored: true });
    expect(entry(p, LOCAL).key.resourceUrl).toBe("mcp://tool/a");
  });

  const pubnet = { ...req, network: "stellar:pubnet" } as PaymentRequirements;

  // 0054: the catalog lists only public `http(s)` hosts, on every network, unless `listLocal`.
  it.each([
    // Loopback names, in the spellings WHATWG folds into `localhost`.
    ["http://localhost:4022/exact/stellar", http],
    ["http://LOCALHOST/a", http],
    ["http://foo.localhost/a", http],
    ["http://ｌｏｃａｌｈｏｓｔ/a", http],
    ["http://local%68ost/a", http],
    // IPv4 spellings WHATWG turns into dotted quads.
    ["http://127.0.0.1:8080/a", http],
    ["http://127.1/a", http],
    ["http://2130706433/a", http],
    ["http://0x7f000001/a", http],
    ["http://0177.0.0.1/a", http],
    ["http://127.0.0.1./a", http],
    ["http://0/a", http],
    // IPv6, private, link-local and public IP literals.
    ["https://[::1]/a", http],
    ["https://[::ffff:127.0.0.1]/a", http],
    ["https://10.0.0.1/a", http],
    ["https://192.168.1.1/a", http],
    ["https://169.254.169.254/a", http],
    ["https://8.8.8.8/a", http],
    ["https://[2606:4700:4700::1111]/a", http],
    // Single-label names and private or special-use suffixes.
    ["https://intranet/a", http],
    ["http://printer.local/a", http],
    ["https://metadata.google.internal/a", http],
    ["https://router.home.arpa/a", http],
    ["https://x.localdomain/a", http],
    ["https://x.invalid/a", http],
    ["https://x.test/a", http],
    ["https://shop.example/a", http],
    ["https://x.alt/a", http],
    ["https://x.onion/a", http],
    // Never delegated by ICANN (2018): internal names only, like `.internal`.
    ["https://nas.home/a", http],
    ["https://intranet.corp/a", http],
    ["https://smtp.mail/a", http],
    // An mcp listing: a tool name, an mcp: host and a loopback http URL.
    ["mcp://tool/get_weather", mcp],
    ["mcp://srv.example.com/x", mcp],
    ["http://localhost:4022/mcp", mcp],
  ])(
    "refuses %s as resource_not_public on testnet and pubnet, and lists it with listLocal",
    (url, info) => {
      for (const requirements of [req, pubnet]) {
        const refused = validate(pay(url, { info }), requirements)!;
        expect(refused).toMatchObject({ ok: false, reason: "resource_not_public" });
        expect(toExtensionResponses(refused)).toEqual({
          bazaar: { status: "rejected", rejectedReason: "resource_not_public" },
        });
      }
      expect(validate(pay(url, { info }), req, LOCAL)).toMatchObject({
        ok: true,
        resourceUrl: canonicalizeUrl(url, info.input.type as "http" | "mcp"),
      });
    },
  );

  it.each([
    ["https://API.x.com:443/a?q=1", http, "https://api.x.com/a"],
    // http stays listable on pubnet: a seller behind a TLS proxy sends it (0053 D3).
    ["http://x.com/a", http, "http://x.com/a"],
    ["https://x.com/mcp", mcp, "https://x.com/mcp"],
    ["https://srv.example.com/a", http, "https://srv.example.com/a"],
    // Names that resolve to loopback are the fetcher's to check (ADR 0008), not the catalog's.
    ["https://127.0.0.1.nip.io/a", http, "https://127.0.0.1.nip.io/a"],
    ["https://localtest.me/a", http, "https://localtest.me/a"],
    // A refused suffix only as the last labels: `mail.` and `home.` up front are public names.
    ["https://mail.x.com/a", http, "https://mail.x.com/a"],
    ["https://home.x.com/a", http, "https://home.x.com/a"],
    // `.lan` is a router default but not reserved: a public TLD could still take it.
    ["https://nas.lan/a", http, "https://nas.lan/a"],
  ])("lists %s on testnet and pubnet", (url, info, canonical) => {
    for (const requirements of [req, pubnet]) {
      const r = validate(pay(url, { info }, { mimeType: "" }), requirements);
      if (!r?.ok) throw new Error(JSON.stringify(r));
      expect(normalize(r, requirements).key).toMatchObject({
        network: requirements.network,
        resourceUrl: canonical,
      });
    }
  });

  it.each([
    ["javascript:alert(1)", http],
    ["http://u:p@localhost/a", http],
    ["mcp://tool/a\\b", mcp],
  ])("still refuses %s with listLocal: it opens hosts, not schemes", (url, info) => {
    expect(validate(pay(url, { info }), req, LOCAL)).toMatchObject({
      ok: false,
      reason: "invalid_resource_url",
    });
  });

  it("answers undefined, not a throw, for a type it doesn't know", () => {
    expect(canonicalizeUrl("https://x.com/a", "a2a" as never)).toBeUndefined();
    expect(canonicalizeUrl("https://x.com/a", "toString" as never)).toBeUndefined();
  });

  it("keeps icons https-only with the host rules, since a browser fetches them", () => {
    for (const iconUrl of [
      "https://foo.localhost/i.png",
      "https://intranet/i.png",
      "https://printer.local/i.png",
      "https://metadata.google.internal/i.png",
      "http://x.com/i.png",
      "https://localhost/i.png",
      "https://10.0.0.1/i.png",
      "https://cdn.x.test/i.png",
      "https://cdn.example/i.png",
      "https://x.alt/i.png",
      "https://x.onion/i.png",
      "https://nas.home/i.png",
    ])
      expect(
        entry(pay("https://x.com/a", { info: http }, { iconUrl })).resource,
      ).not.toHaveProperty("iconUrl");
  });

  it("does no I/O, reads no env or clock, and compiles no schema", () => {
    const src = join(import.meta.dirname, "../src");
    for (const file of readdirSync(src)) {
      const code = readFileSync(join(src, file), "utf8");
      expect(code).not.toMatch(/from "node:|(?<![\w-])process\.|\bDate\b|\bfetch\(|\bcompile\(/);
    }
  });
});
