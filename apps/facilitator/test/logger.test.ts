import { expect, it } from "vitest";
import { jsonLogger } from "../src/logger.js";

it("keeps the envelope over fields and logs an error's stack and cause", () => {
  const lines: string[] = [];
  const error = new Error("submit failed", { cause: new Error("rpc down") });
  jsonLogger("debug", (line) => lines.push(line)).error("x", { level: "debug", event: "y", error });

  const entry = JSON.parse(lines[0] ?? "");
  expect(entry).toMatchObject({
    level: "error",
    event: "x",
    error: { name: "Error", message: "submit failed", cause: { message: "rpc down" } },
  });
  expect(entry.error.stack).toContain("submit failed");
});
