import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { captureConsoleError, jsonLogger, redactUrls, rpcEndpointName } from "../src/logger.js";

const capture = () => {
  const lines: string[] = [];
  return { lines, logger: jsonLogger("debug", (line) => lines.push(line)) };
};

it("keeps the envelope over fields and logs an error's stack and one level of cause", () => {
  const { lines, logger } = capture();
  const cause = new Error("rpc down");
  const error = new Error("submit failed", { cause });
  cause.cause = error; // a cyclic chain must not loop the serializer
  logger.error("x", { level: "debug", event: "y", error });

  const entry = JSON.parse(lines[0] ?? "");
  expect(entry).toMatchObject({
    level: "error",
    event: "x",
    error: { name: "Error", message: "submit failed", cause: { message: "rpc down" } },
  });
  expect(entry.error.stack).toContain("submit failed");
  expect(entry.error.cause.cause).toBeUndefined();
});

it("never logs the toJSON snapshot of an error", () => {
  // Like an AxiosError from stellar-sdk's RPC client: its snapshot holds the request body.
  class RequestError extends Error {
    toJSON() {
      return { message: this.message, config: { data: "SIGNED_TRANSACTION_XDR" } };
    }
  }
  const { lines, logger } = capture();
  logger.error("x", { error: new RequestError("Request failed with status code 500") });

  expect(lines[0]).not.toContain("SIGNED_TRANSACTION_XDR");
  expect(JSON.parse(lines[0] ?? "").error).toMatchObject({
    name: "Error",
    message: "Request failed with status code 500",
  });
});

it("keeps the event when a field can't be serialized, instead of throwing", () => {
  const { lines, logger } = capture();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  logger.error("x", { error: cyclic });

  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    level: "error",
    event: "x",
    fields: "unserializable",
  });
});

it("reduces URLs to their host, so an RPC key in the path or query stays out of the logs", () => {
  expect(
    redactUrls("GET https://rpc.example/v1/K?apikey=K failed; also http://u:p@node:8000/x."),
  ).toBe("GET rpc.example failed; also node:8000");
});

it("redacts an upper-case scheme and an unparseable URL, and keeps stack locations", () => {
  expect(redactUrls("GET HTTPS://acct.example/KEY failed")).toBe("GET acct.example failed");
  expect(redactUrls("GET http://[::1/KEY failed")).toBe("GET [url] failed");
  const location = "at settle (file:///app/dist/settlement/settle.js:10:5)";
  expect(redactUrls(location, ["https://acct.example/K/"])).toBe(location);
});

it("names a URL by the longest RPC_URLS entry it starts with", () => {
  const rpcUrls = ["https://acct.example/", "https://acct.example/K/"];
  expect(redactUrls("POST https://acct.example/K/rpc failed", rpcUrls)).toBe(
    `POST ${rpcEndpointName("https://acct.example/K/", 1)} failed`,
  );
  // In the other order too, so neither the first nor the last match wins by position.
  expect(redactUrls("POST https://acct.example/K/rpc failed", [...rpcUrls].reverse())).toBe(
    `POST ${rpcEndpointName("https://acct.example/K/", 0)} failed`,
  );
});

it("names an RPC_URLS entry by index and fingerprint, never by host", () => {
  const primary = "https://acct-1.paid.example/K/";
  const fallback = "https://rpc.other.example/v1?apikey=K2";
  const rpcUrls = [primary, fallback, "https://acct-1.paid.example/K3/"];
  const fingerprint = createHash("sha256").update(primary).digest("hex").slice(0, 8);
  expect(rpcEndpointName(primary, 0)).toBe(`RPC_URLS[0]#${fingerprint}`);

  const text = redactUrls(
    `POST ${primary}rpc failed, then ${fallback} on https://acct-1.paid.example/ at https://horizon.example/x`,
    rpcUrls,
  );
  expect(text).toBe(
    `POST ${rpcEndpointName(primary, 0)} failed, then ${rpcEndpointName(fallback, 1)} ` +
      `on ${rpcEndpointName(primary, 0)}|${rpcEndpointName(rpcUrls[2] ?? "", 2)} at horizon.example`,
  );
  expect(text).not.toMatch(/K|paid|other/);
});

it("names an RPC_URLS entry's bare host, as Node's network errors give it", () => {
  const rpcUrls = [
    "https://acct-1234.quiknode.example/K/",
    "https://acct-1234.quiknode.example/K2/",
  ];
  const names = rpcUrls.map((url, index) => rpcEndpointName(url, index)).join("|");
  expect(redactUrls("getaddrinfo ENOTFOUND acct-1234.quiknode.example", rpcUrls)).toBe(
    `getaddrinfo ENOTFOUND ${names}`,
  );
  expect(redactUrls("connect ETIMEDOUT ACCT-1234.quiknode.example:443.", rpcUrls)).toBe(
    `connect ETIMEDOUT ${names}:443.`,
  );
  expect(
    redactUrls(
      "Hostname/IP does not match certificate's altnames: Host: acct-1234.quiknode.example. is not in",
      rpcUrls,
    ),
  ).toBe(`Hostname/IP does not match certificate's altnames: Host: ${names}. is not in`);
  // Only the whole name: a longer one that contains it is another host.
  const other = "x.acct-1234.quiknode.example and acct-1234.quiknode.example.org";
  expect(redactUrls(other, rpcUrls)).toBe(other);
});

it("names an RPC_URLS host in a logged error's message, stack and cause", () => {
  const rpcUrls = ["https://acct-1.paid.example/K/"];
  const lines: string[] = [];
  const logger = jsonLogger("debug", (line) => lines.push(line), rpcUrls);
  logger.error("x", {
    error: new Error("fetch failed", {
      cause: new Error("getaddrinfo ENOTFOUND acct-1.paid.example"),
    }),
  });
  const restore = captureConsoleError(logger, rpcUrls);
  try {
    console.error(new Error("connect ETIMEDOUT acct-1.paid.example:443"));
  } finally {
    restore();
  }
  expect(lines.join("")).not.toContain("paid");
});

it("names RPC_URLS entries in logged errors and console.error", () => {
  const rpcUrls = ["https://acct-1.paid.example/K/"];
  const lines: string[] = [];
  const logger = jsonLogger("debug", (line) => lines.push(line), rpcUrls);
  logger.error("x", { error: new Error("fetch https://acct-1.paid.example/K/ failed") });
  const restore = captureConsoleError(logger, rpcUrls);
  try {
    console.error("verify failed at https://acct-1.paid.example/K/");
  } finally {
    restore();
  }

  const name = rpcEndpointName(rpcUrls[0] ?? "", 0);
  expect(JSON.parse(lines[0] ?? "").error.message).toBe(`fetch ${name} failed`);
  expect(JSON.parse(lines[1] ?? "").message).toBe(`verify failed at ${name}`);
});

it("logs every console.error as one error event, with URLs reduced to their host", () => {
  const { lines, logger } = capture();
  const restore = captureConsoleError(logger);
  try {
    const error = Object.assign(new Error("Request failed with status code 503"), {
      config: { url: "https://rpc.example/?apikey=K", data: "AAAA" },
      cause: new Error("socket hang up at https://rpc.example/?apikey=K"),
    });
    console.error("Unexpected verification error:", error, "at https://rpc.example/?apikey=K");
    // The SDK throws a JSON-RPC error as a plain object.
    console.error("Unexpected verification error:", { code: -32001, message: "quota exceeded" });
    // Neither may make `console.error` throw.
    console.error(Object.create(null), 1n);
    console.error({
      toString() {
        throw new Error("no");
      },
      toJSON() {
        throw new Error("no");
      },
    });
  } finally {
    restore();
  }
  const entries = lines.map((line) => JSON.parse(line));
  expect(entries).toEqual([
    expect.objectContaining({
      level: "error",
      event: "console_error",
      message:
        "Unexpected verification error: Error: Request failed with status code 503 at rpc.example",
      errors: [
        expect.objectContaining({
          name: "Error",
          message: "Request failed with status code 503",
          stack: expect.stringContaining("Request failed"),
          cause: expect.objectContaining({ message: "socket hang up at rpc.example" }),
        }),
      ],
    }),
    expect.objectContaining({
      message: 'Unexpected verification error: {"code":-32001,"message":"quota exceeded"}',
    }),
    expect.objectContaining({ message: "{} 1" }),
    expect.objectContaining({ message: "unformattable console.error arguments" }),
  ]);
  expect(lines.join("")).not.toContain("apikey");
});

it("logs an error field's URLs by host only, its cause's too", () => {
  const { lines, logger } = capture();
  const cause = new Error("connect ECONNREFUSED https://rpc.example/v1/SECRETKEY");
  logger.error("settlement_submit_failed", {
    error: new Error("POST https://rpc.example/v1/SECRETKEY failed", { cause }),
  });

  expect(lines[0]).not.toContain("SECRETKEY");
  expect(JSON.parse(lines[0] ?? "").error).toMatchObject({
    message: "POST rpc.example failed",
    cause: { message: "connect ECONNREFUSED rpc.example" },
  });
});
