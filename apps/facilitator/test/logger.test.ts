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

it("logs upstream's console.error as one event, an error as name and message only", () => {
  const { lines, logger } = capture();
  const restore = captureConsoleError(logger);
  try {
    const error = Object.assign(new Error("Request failed with status code 503"), {
      config: { url: "https://rpc.example/?apikey=K", data: "AAAA" },
    });
    console.error("Unexpected verification error:", error, "at https://rpc.example/?apikey=K");
  } finally {
    restore();
  }
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({
      level: "warn",
      event: "upstream_console_error",
      message:
        "Unexpected verification error: Error: Request failed with status code 503 at rpc.example",
    }),
  ]);
  expect(lines.join("")).not.toContain("apikey");
});
