import { expect, it } from "vitest";
import { captureConsoleError, jsonLogger, redactUrls } from "../src/logger.js";

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
