// stellar-x402-mcp end to end (task 0037): the built CLI over MCP stdio, as Claude Desktop runs it.
// Scenarios E-01…E-23 were written from the README, the tool list and the acceptance criteria only,
// by a reviewer who had not read the code. Two real testnet payments of 0.001 USDC (E-21, E-22) go
// to the example seller and settle through the public x402.org facilitator; every other paid path
// uses a local fake seller that never forwards what it receives, so no money moves.
//
// Run from the repo root: pnpm e2e:testnet. Results go to results/testnet-results.json.
import { afterAll, beforeAll, it } from "vitest";
import { captured, started } from "../src/cli.js";
import { row } from "../src/results.js";
import { drained } from "./after-signing.js";
import { keys, setUp, tearDown, unfunded } from "./context.js";
// The scenario groups, in the order they run.
import "./start-up.js";
import "./catalog.js";
import "./get-resource.js";
import "./refusals.js";
import "./after-signing.js";
import "./real-payments.js";

beforeAll(setUp);
afterAll(tearDown);

it("E-23 no secret appears in anything the servers wrote", () => {
  const all = captured.join("\n");
  const secrets = {
    buyer: keys.buyerSecret,
    "buyer without its S": keys.buyerSecret.slice(1),
    unfunded: unfunded.secret(),
    "drained (E-14b)": drained,
    "malformed key of E-01l": "SNOTAVALIDKEY0123456789",
  };
  for (const [name, secret] of Object.entries(secrets).filter(([, value]) => value !== ""))
    row(
      "E-23",
      `no ${name} secret in ${captured.length} captures from ${started.count} processes`,
      false,
      all.includes(secret),
    );
});
