import { afterEach, describe, expect, it, vi } from "vitest";

const undiciFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetch,
}));

const { guardedFetch, publicOnlyLookup } = await import("../src/seller.js");

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

describe("guardedFetch", () => {
  afterEach(() => undiciFetch.mockReset());

  it.each([
    [false, true],
    [true, false],
  ])(
    "with allowInsecureLocal %s, connects through the public-only agent: %s",
    async (local, checked) => {
      undiciFetch.mockResolvedValue(new Response("{}", { status: 200 }));
      const limits = { timeoutMs: 1_000, maxResponseBytes: 1_000, allowInsecureLocal: local };
      await guardedFetch(limits)("https://seller.example/x");
      const [, init] = undiciFetch.mock.calls[0]!;
      expect(init.dispatcher !== undefined).toBe(checked);
    },
  );

  it("refuses a private IP address written in the URL before connecting", async () => {
    const limits = { timeoutMs: 1_000, maxResponseBytes: 1_000, allowInsecureLocal: false };
    await expect(guardedFetch(limits)("https://10.0.0.5/x")).rejects.toMatchObject({
      code: "unsafe_url",
    });
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("passes on a refusal from the lookup with its own code", async () => {
    const { ToolError } = await import("../src/results.js");
    const refused = new ToolError("unsafe_url", "refused");
    undiciFetch.mockRejectedValue(new TypeError("fetch failed", { cause: refused }));
    const limits = { timeoutMs: 1_000, maxResponseBytes: 1_000, allowInsecureLocal: false };
    await expect(guardedFetch(limits)("https://seller.example/x")).rejects.toBe(refused);
  });
});
