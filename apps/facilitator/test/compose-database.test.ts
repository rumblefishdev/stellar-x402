import { describe, expect, it } from "vitest";
import { COMPOSE_DATABASE_URL, databaseUrlOrCompose, urlOrCompose } from "./compose-database.js";

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

describe("urlOrCompose", () => {
  it.each([
    ["unset", {}],
    ["empty", { TEST_DATABASE_URL: "" }],
    ["blank", { TEST_DATABASE_URL: " \n" }],
  ])("falls back to the compose database when the variable is %s", (_name, env) => {
    expect(urlOrCompose("TEST_DATABASE_URL", env)).toBe(COMPOSE_DATABASE_URL);
  });

  it("reads only the variable it is given", () => {
    const env = {
      DATABASE_URL: "postgres://db.internal/x402",
      TEST_DATABASE_URL: " postgres://ci/x ",
    };
    expect(urlOrCompose("TEST_DATABASE_URL", env)).toBe("postgres://ci/x");
  });
});
