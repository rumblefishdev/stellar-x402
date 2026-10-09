import { expect, it } from "vitest";
import { jsonLogger } from "../src/logger.js";

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
