import { describe, expect, it } from "vitest";
import { COMPOSE_DATABASE_URL, databaseUrlOrCompose } from "./compose-database.js";

describe("databaseUrlOrCompose", () => {
  it.each([
    ["unset", {}],
    ["empty", { DATABASE_URL: "" }],
    ["blank", { DATABASE_URL: " \n" }],
  ])("falls back to the compose database when DATABASE_URL is %s", (_name, env) => {
    expect(databaseUrlOrCompose(env)).toBe(COMPOSE_DATABASE_URL);
  });

  it("uses DATABASE_URL when it is set, trimmed", () => {
    expect(databaseUrlOrCompose({ DATABASE_URL: " postgres://db.internal/x402\n" })).toBe(
      "postgres://db.internal/x402",
    );
  });
});
