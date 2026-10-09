import { describe, expect, it, vi } from "vitest";
import { toExtensionResponses, validate, type ValidationResult } from "../src/index.js";
import { httpInfo, mcpInfo, nested, payload, requirements } from "./fixtures.js";

const reasonOf = (result: ValidationResult | undefined) =>
  result && !result.ok ? result.reason : result?.ok ? "ok" : "undefined";

describe("validate: presence and version", () => {
  it("returns undefined only when the raw payload has no extensions.bazaar key", () => {
    const p = payload();
    delete (p.extensions as Record<string, unknown>).bazaar;
    expect(validate(p, requirements)).toBeUndefined();
    expect(validate({ ...p, extensions: undefined }, requirements)).toBeUndefined();
  });

  it.each([
    ["a string", "x"],
    ["null", null],
    ["an array", []],
  ])("rejects a bazaar block that is %s as invalid_extension", (_, bazaar) => {
    expect(reasonOf(validate(payload({ bazaar }), requirements))).toBe("invalid_extension");
  });

  it.each([1, 3, undefined])("rejects x402Version %j as unsupported_version", (x402Version) => {
    expect(reasonOf(validate(payload({ x402Version }), requirements))).toBe("unsupported_version");
  });
});

describe("validate: order of checks (G3)", () => {
  it.each([
    ["missing resource.url", payload({ url: undefined }), "invalid_resource_url"],
    ["unparsable resource.url", payload({ url: "not a url" }), "invalid_resource_url"],
    ["bazaar block without info", payload({ bazaar: { schema: {} } }), "invalid_info"],
    ["info without input", payload({ info: {} }), "invalid_info"],
    ["http without method (G3b)", payload({ info: { input: { type: "http" } } }), "invalid_info"],
  ])("%s → %s, never internal_error", (_, p, reason) => {
    expect(reasonOf(validate(p, requirements))).toBe(reason);
  });

  it("checks the shape before the URL", () => {
    expect(reasonOf(validate(payload({ info: {}, url: "bad" }), requirements))).toBe(
      "invalid_info",
    );
  });

  it("turns an unexpected throw into internal_error", async () => {
    vi.resetModules();
    vi.doMock("@x402/extensions/bazaar", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      extractDiscoveryInfo: () => {
        throw new Error("boom");
      },
    }));
    const { validate: mocked } = await import("../src/validate.js");
    const result = mocked(payload(), requirements);
    expect(result).toEqual({ ok: false, reason: "internal_error", detail: "boom" });
    vi.doUnmock("@x402/extensions/bazaar");
    vi.resetModules();
  });
});

describe("validate: info rules (G2)", () => {
  it.each([
    ["method TRACE", { input: { type: "http", method: "TRACE" } }],
    ["an object toolName", { input: { type: "mcp", toolName: { a: 1 }, inputSchema: {} } }],
    ["type ftp", { input: { type: "ftp" } }],
    ["a toolName with surrounding whitespace", { input: { ...mcpInfo.input, toolName: " tool" } }],
    ["a toolName with a control character", { input: { ...mcpInfo.input, toolName: "a\u0007b" } }],
    ["a toolName over 128 characters", { input: { ...mcpInfo.input, toolName: "t".repeat(129) } }],
  ])("rejects %s even with schema {}", (_, info) => {
    expect(reasonOf(validate(payload({ info, schema: {} }), requirements))).toBe("invalid_info");
  });

  it.each(["text", "a/b/c", "x".repeat(60) + "/" + "y".repeat(70)])(
    "rejects mimeType %j",
    (mimeType) => {
      expect(reasonOf(validate(payload({ resource: { mimeType } }), requirements))).toBe(
        "invalid_info",
      );
    },
  );

  it("accepts a mimeType with parameters", () => {
    const p = payload({ resource: { mimeType: "application/json; charset=utf-8" } });
    expect(reasonOf(validate(p, requirements))).toBe("ok");
  });
});

describe("validate: limits (G1, G9)", () => {
  it("rejects a 501-character description and a 33 KiB extension as too_large", () => {
    expect(
      reasonOf(validate(payload({ resource: { description: "d".repeat(501) } }), requirements)),
    ).toBe("too_large");
    const big = payload({ info: { ...httpInfo, output: { example: "x".repeat(33 * 1024) } } });
    expect(reasonOf(validate(big, requirements))).toBe("too_large");
  });

  it("accepts a 500-character description", () => {
    expect(
      reasonOf(validate(payload({ resource: { description: "d".repeat(500) } }), requirements)),
    ).toBe("ok");
  });

  it("rejects a deep schema as schema_too_complex quickly", () => {
    const started = performance.now();
    expect(reasonOf(validate(payload({ schema: nested(11) }), requirements))).toBe(
      "schema_too_complex",
    );
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("rejects a block too deep to serialize as too_large, without throwing (RT6)", () => {
    expect(reasonOf(validate(payload({ schema: nested(100_000) }), requirements))).toBe(
      "too_large",
    );
  });
});

describe("validate: accepted listings", () => {
  it("keeps upstream's extraction but not its URL fields (G4)", () => {
    const result = validate(
      payload({ url: "https://x.com/cheap", routeTemplate: "/premium" }),
      requirements,
    );
    expect(result).toMatchObject({
      ok: true,
      resourceUrl: "https://x.com/cheap",
      routeTemplateIgnored: true,
    });
    if (!result?.ok) throw new Error("expected ok");
    expect(result.routeTemplate).toBeUndefined();
    expect(result.discovered).not.toHaveProperty("resourceUrl");
    expect(result.discovered).not.toHaveProperty("routeTemplate");
    expect(result.discovered.extensions).toEqual({
      bazaar: { info: httpInfo, schema: { type: "object" } },
    });
  });

  it("keeps a template that matches", () => {
    const result = validate(payload({ routeTemplate: "/users/:userId" }), requirements);
    expect(result).toMatchObject({
      ok: true,
      routeTemplate: "/users/:userId",
      routeTemplateIgnored: false,
    });
  });

  it("ignores a template on mcp (G5)", () => {
    const result = validate(payload({ info: mcpInfo, routeTemplate: "/users/:id" }), requirements);
    expect(result).toMatchObject({ ok: true, routeTemplateIgnored: true });
    expect(result?.ok && result.routeTemplate).toBeFalsy();
  });

  it("echoes only the bazaar extension, never other client extensions", () => {
    const p = payload({ otherExtensions: { "sign-in-with-x": { token: "secret" } } });
    const result = validate(p, requirements);
    expect(result?.ok && Object.keys(result.discovered.extensions ?? {})).toEqual(["bazaar"]);
  });

  it("soft-drops a bad serviceName, tags and iconUrl and keeps the listing", () => {
    const p = payload({
      resource: {
        serviceName: "x".repeat(33),
        tags: ["\u0000"],
        iconUrl: "https://foo.localhost/i.png",
      },
    });
    const result = validate(p, requirements);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.discovered.serviceName).toBeUndefined();
    expect(result.discovered.tags).toBeUndefined();
    expect(result.discovered.iconUrl).toBeUndefined();
  });

  it("stores the canonical icon href", () => {
    const result = validate(
      payload({ resource: { iconUrl: "https://CDN.example.com/i.png" } }),
      requirements,
    );
    expect(result?.ok && result.discovered.iconUrl).toBe("https://cdn.example.com/i.png");
  });
});

describe("toExtensionResponses", () => {
  it("emits processing or rejectedReason, never detail", () => {
    const ok = validate(payload(), requirements)!;
    expect(toExtensionResponses(ok)).toEqual({ bazaar: { status: "processing" } });
    const rejected = validate(payload({ url: "http://x.com/a" }), requirements)!;
    const header = toExtensionResponses(rejected);
    expect(header).toEqual({
      bazaar: { status: "rejected", rejectedReason: "invalid_resource_url" },
    });
    expect(JSON.stringify(header)).not.toContain("detail");
  });
});
