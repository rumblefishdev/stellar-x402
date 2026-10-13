import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

const { checkUrl, guardedFetch, publicOnlyLookup } = await import("../src/guard.js");

function resolve(hostname: string, all: boolean) {
  return new Promise<{ error: Error | null; address: unknown }>((done) =>
    publicOnlyLookup(hostname, { all }, (error, address) => done({ error, address })),
  );
}

describe("publicOnlyLookup", () => {
  it("refuses a name that resolves to a loopback address", async () => {
    const { error } = await resolve("localhost", true);
    expect(error).toMatchObject({ code: "unsafe_url" });
  });

  it("answers a public address in the shape the caller asked for", async () => {
    expect((await resolve("8.8.8.8", true)).address).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect((await resolve("8.8.8.8", false)).address).toBe("8.8.8.8");
  });
});

describe("checkUrl", () => {
  it("with allowInsecureLocal, passes http to a *.localhost name, which only this machine answers", () => {
    expect(checkUrl("http://x.localhost:8080/", true).hostname).toBe("x.localhost");
    expect(() => checkUrl("http://x.localhost:8080/", false)).toThrow(
      expect.objectContaining({ code: "unsafe_url" }),
    );
  });

  it("with allowInsecureLocal, still refuses a scheme other than http and https on this machine", () => {
    expect(() => checkUrl("ftp://localhost/x", true)).toThrow(
      expect.objectContaining({ code: "unsafe_url" }),
    );
  });
});

describe("guardedFetch", () => {
  afterEach(() => undiciFetch.mockReset());

  it("refuses a private IP address written in the URL before connecting", async () => {
    const limits = { timeoutMs: 1_000, maxResponseBytes: 1_000, allowInsecureLocal: false };
    await expect(
      guardedFetch(limits, AbortSignal.timeout(limits.timeoutMs))("https://10.0.0.5/x"),
    ).rejects.toMatchObject({
      code: "unsafe_url",
    });
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it.each([["https://10.0.0.5/x"], ["http://example.com/x"]])(
    "with allowInsecureLocal, still refuses %s: the switch opens only this machine",
    async (url) => {
      const limits = { timeoutMs: 1_000, maxResponseBytes: 1_000, allowInsecureLocal: true };
      await expect(
        guardedFetch(limits, AbortSignal.timeout(limits.timeoutMs))(url),
      ).rejects.toMatchObject({ code: "unsafe_url" });
      expect(undiciFetch).not.toHaveBeenCalled();
    },
  );

  it("with allowInsecureLocal, reaches this machine by name and still checks every other name", async () => {
    const { fetch: realFetch } = await vi.importActual<typeof import("undici")>("undici");
    undiciFetch.mockImplementation(realFetch);
    const seller = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((done) => seller.listen(0, "127.0.0.1", done));
    const { port } = seller.address() as AddressInfo;
    const limits = { timeoutMs: 5_000, maxResponseBytes: 1_000, allowInsecureLocal: true };
    try {
      expect(
        (
          await guardedFetch(
            limits,
            AbortSignal.timeout(limits.timeoutMs),
          )(`http://localhost:${port}/`)
        ).status,
      ).toBe(200);
      // "localhost." is not a loopback name to the switch, so its lookup is checked and refused.
      await expect(
        guardedFetch(limits, AbortSignal.timeout(limits.timeoutMs))(`https://localhost.:${port}/`),
      ).rejects.toMatchObject({
        code: "unsafe_url",
      });
    } finally {
      seller.close();
    }
  });

  it("passes on a refusal from the lookup with its own code", async () => {
    const { ToolError } = await import("../src/results.js");
    const refused = new ToolError("unsafe_url", "refused");
    undiciFetch.mockRejectedValue(new TypeError("fetch failed", { cause: refused }));
    const limits = { timeoutMs: 1_000, maxResponseBytes: 1_000, allowInsecureLocal: false };
    await expect(
      guardedFetch(limits, AbortSignal.timeout(limits.timeoutMs))("https://seller.example/x"),
    ).rejects.toBe(refused);
  });

  it("counts the size after decompression, so a small gzip body cannot unpack past the limit", async () => {
    const { fetch: realFetch } = await vi.importActual<typeof import("undici")>("undici");
    undiciFetch.mockImplementation(realFetch);
    // About 10 kB on the wire, 10 MB unpacked.
    const packed = gzipSync(Buffer.alloc(10_000_000, 97));
    const seller = createServer((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      res.end(packed);
    });
    await new Promise<void>((done) => seller.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(seller.address() as AddressInfo).port}/`;
    const limits = { timeoutMs: 5_000, maxResponseBytes: 100_000, allowInsecureLocal: true };
    try {
      await expect(
        guardedFetch(limits, AbortSignal.timeout(limits.timeoutMs))(url),
      ).rejects.toMatchObject({ code: "response_too_large" });
    } finally {
      seller.close();
    }
  });
});
