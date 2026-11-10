import { describe, it } from "vitest";
import { failedStart, startServer } from "../src/cli.js";
import { startFakeSeller } from "../src/fakes.js";
import { row } from "../src/results.js";
import { base, httpArgs, keys, paying, PRICE, terms } from "./context.js";

describe("start-up", () => {
  it("E-01 refuses wrong settings, exits on its own and names the variable", async () => {
    const key = keys.buyerSecret;
    const noCatalog = base();
    delete noCatalog.STELLAR_X402_DISCOVERY_URL;
    const cases: [string, Record<string, string>, string][] = [
      ["a", noCatalog, "STELLAR_X402_DISCOVERY_URL"],
      ["b", base({ STELLAR_X402_DISCOVERY_URL: "" }), "STELLAR_X402_DISCOVERY_URL"],
      ["c", base({ STELLAR_X402_SECRET_KEY: key }), "STELLAR_X402_MAX_PER_CALL"],
      [
        "d",
        base({ STELLAR_X402_SECRET_KEY: key, STELLAR_X402_MAX_PER_CALL: PRICE }),
        "STELLAR_X402_DAILY_BUDGET",
      ],
      // No network setting: it pays on testnet only, and the name is refused as unknown.
      [
        "f",
        paying({ STELLAR_X402_NETWORK: "stellar:pubnet" }),
        "STELLAR_X402_NETWORK is not a setting",
      ],
      ["g", paying({ STELLAR_X402_MAX_PER_CALL: "1e3" }), "STELLAR_X402_MAX_PER_CALL"],
      ["h", base({ STELLAR_X402_TIMEOUT_MS: "0" }), "STELLAR_X402_TIMEOUT_MS"],
      ["i", base({ STELLAR_X402_MAX_PERCALL: "10" }), "STELLAR_X402_MAX_PERCALL"],
      ["j", paying({ STELLAR_X402_BUDGET: "100" }), "STELLAR_X402_BUDGET is not a setting"],
      [
        "l",
        paying({ STELLAR_X402_SECRET_KEY: "SNOTAVALIDKEY0123456789" }),
        "STELLAR_X402_SECRET_KEY",
      ],
      ["m", paying({ STELLAR_X402_STATE_DIR: "relative/dir" }), "STELLAR_X402_STATE_DIR"],
    ];
    for (const [id, env, says] of cases) {
      const { code: exit, stderr } = await failedStart(env);
      // Exit code 1 (README); a server killed after 10 s would show null.
      row(`E-01${id}`, `exit 1, stderr says "${says}"`, [1, true], [exit, stderr.includes(says)]);
    }
  });

  it("E-02 offers two tools without a key, and call_paid_http is the SDK's error", async () => {
    const fake = await startFakeSeller(terms, { "/ok": {} });
    const server = await startServer(base());
    const tools = await server.tools();
    row(
      "E-02",
      "tools, each with an output schema",
      [["get_resource", "list_resources"], true],
      [tools.map((t) => t.name).sort(), tools.every((t) => t.outputSchema !== undefined)],
    );
    const answer = await server.call("call_paid_http", httpArgs(`${fake.url}/ok`));
    row(
      "E-02",
      "call_paid_http: -32602, not our shape, nothing sent",
      [true, true, undefined, 0],
      [answer.isError, answer.text.includes("-32602"), answer.value?.error, fake.requests.length],
    );
    await server.close();
    await fake.close();
  });

  it("E-03 offers three tools with a key and logs only the public address", async () => {
    const server = await startServer(paying());
    const tools = await server.tools();
    row(
      "E-03",
      "tools, each with an output schema",
      [["call_paid_http", "get_resource", "list_resources"], true],
      [tools.map((t) => t.name).sort(), tools.every((t) => t.outputSchema !== undefined)],
    );
    row(
      "E-03",
      "call_paid_http is destructive",
      true,
      tools.find((t) => t.name === "call_paid_http")?.annotations?.destructiveHint,
    );
    await server.close();
    row(
      "E-03",
      "stderr names the buyer's public address",
      true,
      server.stderr().includes(keys.buyerPublic),
    );
  });
});
