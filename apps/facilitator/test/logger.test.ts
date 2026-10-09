import { expect, it } from "vitest";
import { jsonLogger } from "../src/logger.js";

it("keeps the envelope over fields and logs an error's stack and one level of cause", () => {
  const lines: string[] = [];
  const cause = new Error("rpc down");
  const error = new Error("submit failed", { cause });
  cause.cause = error; // a cyclic chain must not loop the serializer
  jsonLogger("debug", (line) => lines.push(line)).error("x", { level: "debug", event: "y", error });

  const entry = JSON.parse(lines[0] ?? "");
  expect(entry).toMatchObject({
    level: "error",
    event: "x",
    error: { name: "Error", message: "submit failed", cause: { message: "rpc down" } },
  });
  expect(entry.error.stack).toContain("submit failed");
  expect(entry.error.cause.cause).toBeUndefined();
});
