import { existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { PaymentRequired } from "@x402/core/types";
import { describe, it } from "vitest";
import { code, startServer } from "../src/cli.js";
import { answer402, startFakeSeller, withOffers } from "../src/fakes.js";
import { usdcBalance } from "../src/horizon.js";
import { row } from "../src/results.js";
import { base, hitsOf, httpArgs, keys, paying, PRICE, terms, weather } from "./context.js";

describe("get_resource", () => {
  it("E-07 reads the example seller's terms and spends nothing", async () => {
    const before = await usdcBalance(keys.buyerPublic);
    const server = await startServer(base());
    const answer = await server.call("get_resource", httpArgs(weather()));
    await server.close();
    const value = answer.value as { status: number; paymentRequired: PaymentRequired };
    const offer = value.paymentRequired.accepts[0]!;
    row(
      "E-07",
      "402 at 10000 on testnet, valid ≤ 300 s",
      [402, PRICE, "stellar:testnet", true],
      [value.status, offer.amount, offer.network, offer.maxTimeoutSeconds <= 300],
    );
    row(
      "E-07",
      "buyer balance unchanged",
      String(before),
      String(await usdcBalance(keys.buyerPublic)),
    );
  });

  it("E-08 answers each seller failure with its code", async () => {
    let nested: unknown = { type: "string" };
    for (let i = 0; i < 50; i++) nested = { type: "object", properties: { a: nested } };
    const fake = await startFakeSeller(terms, {
      "/free": {
        unpaid: (res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"),
      },
      "/nohdr": { unpaid: (res) => res.writeHead(402).end("{}") },
      "/deep": {
        unpaid: (res, t) =>
          answer402({
            ...t,
            extensions: { bazaar: { ...(t.extensions?.bazaar as object), schema: nested } },
          })(res),
      },
      "/boom": { unpaid: (res) => res.writeHead(500).end() },
      "/big": { unpaid: (res) => res.writeHead(200).end("x".repeat(5_000)) },
      "/gzip": {
        unpaid: (res) =>
          res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(Buffer.alloc(1_000_000))),
      },
      "/stall": { unpaid: (res) => res.writeHead(200).write("part") },
      "/redir": { unpaid: (res) => res.writeHead(302, { location: `${fake.url}/free` }).end() },
      "/pubnet402": {
        unpaid: (res, t) => answer402(withOffers(t, { network: "stellar:pubnet" }))(res),
      },
    });
    const server = await startServer(base({ STELLAR_X402_MAX_RESPONSE_BYTES: "1000" }));
    const cases: [string, string, string][] = [
      ["a", "/free", "ok"],
      ["b", "/nohdr", "unsupported_payment"],
      ["c", "/deep", "ok"],
      ["d", "/gone", "resource_not_found"],
      ["e", "/boom", "upstream_error"],
      ["f", "/big", "response_too_large"],
      ["g", "/gzip", "response_too_large"],
      ["h", "/stall", "upstream_error"],
      ["i", "/redir", "unsafe_url"],
      ["j", "/pubnet402", "ok"],
    ];
    for (const [id, path, expected] of cases) {
      const freeBefore = hitsOf(fake, "/free");
      const begin = Date.now();
      const answer = await server.call("get_resource", httpArgs(`${fake.url}${path}`));
      // The 3 s time limit, and 1 s of slack.
      row(
        `E-08${id}`,
        `get_resource ${path}, within 4 s`,
        [expected, true],
        [code(answer), Date.now() - begin < 4_000],
      );
      if (path === "/redir")
        row("E-08i", "redirect not followed", freeBefore, hitsOf(fake, "/free"));
      if (path === "/pubnet402") {
        const value = answer.value as { status: number; paymentRequired: PaymentRequired };
        row(
          "E-08j",
          "terms returned as given",
          [402, "stellar:pubnet"],
          [value.status, value.paymentRequired.accepts[0]!.network],
        );
      }
    }
    await server.close();
    await fake.close();
  });

  it("E-09 refuses addresses that are not public, before any request", async () => {
    const fake = await startFakeSeller(terms, {
      "/free": { unpaid: (res) => res.writeHead(200).end("{}") },
    });
    const env = paying();
    const server = await startServer(env);
    const refused: [string, string, string][] = [
      ["a", "get_resource", "not a url"],
      ["b", "get_resource", "http://example.com/"],
      ["c", "get_resource", "https://10.0.0.1/x"],
      ["d", "get_resource", "http://192.168.1.1/x"],
      ["e", "call_paid_http", "https://169.254.169.254/latest"],
      // A public name pointing at 127.0.0.1 (public DNS): the switch opens only this machine's names.
      ["g", "get_resource", `${fake.url.replace("127.0.0.1", "127.0.0.1.nip.io")}/free`],
    ];
    for (const [id, tool, url] of refused)
      row(
        `E-09${id}`,
        `${tool} ${url}`,
        "unsafe_url",
        code(await server.call(tool, httpArgs(url))),
      );
    const local = fake.url.replace("127.0.0.1", "localhost");
    row(
      "E-09",
      "control: localhost and 127.0.0.1 pass with the switch",
      ["ok", "ok"],
      [
        code(await server.call("get_resource", httpArgs(`${local}/free`))),
        code(await server.call("get_resource", httpArgs(`${fake.url}/free`))),
      ],
    );
    await server.close();
    const strict = { ...env };
    delete strict.STELLAR_X402_ALLOW_INSECURE_LOCAL;
    const strictServer = await startServer(strict);
    row(
      "E-09f",
      "127.0.0.1 without the switch",
      "unsafe_url",
      code(await strictServer.call("get_resource", httpArgs(`${fake.url}/free`))),
    );
    // The production path, with the switch off: a public https name resolved and checked by the
    // guard, then TLS. No seller of ours runs there; any 200 shows the request went through.
    row(
      "E-09h",
      "https://example.com/ without the switch passes the guard",
      ["ok", 200],
      await strictServer
        .call("get_resource", httpArgs("https://example.com/"))
        .then((answer) => [code(answer), (answer.value as { status?: number })?.status]),
    );
    await strictServer.close();
    row(
      "E-09",
      "nothing counted",
      false,
      existsSync(join(env.STELLAR_X402_STATE_DIR!, "spent.sqlite")),
    );
    row("E-09", "requests reaching the seller: the two controls only", 2, fake.requests.length);
    await fake.close();
  });
});
