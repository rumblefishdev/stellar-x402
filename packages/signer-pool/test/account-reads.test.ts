import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  FallbackRpc,
  SettlementSubmitter,
  checkChannel,
  keypairSigner,
  type SubmitterEvent,
} from "../src/index.js";
import { FakeRpc, channels, facilitator } from "./fake-rpc.js";

// Account reads over HTTP, against a JSON-RPC stub: what an RPC outage looks like to the pool.

/** How the stub answers `getLedgerEntries`. */
type Answer = "503" | "no-entry" | "entry";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A Soroban RPC stub at a local URL. Every method but `getLedgerEntries` is unknown to it. */
async function stub(answer: Answer): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (answer === "503") {
        res.writeHead(503).end("Service Unavailable");
        return;
      }
      const { id, method, params } = JSON.parse(body);
      const reply =
        method !== "getLedgerEntries"
          ? { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }
          : { jsonrpc: "2.0", id, result: ledgerEntries(answer, params.keys[0]) };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  servers.push(server.listen(0, "127.0.0.1"));
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The RPC's `getLedgerEntries` result: no entries for an unknown account (measured on testnet). */
function ledgerEntries(answer: Answer, key: string) {
  if (answer === "no-entry") return { entries: [], latestLedger: 100 };
  const accountId = xdr.LedgerKey.fromXDR(key, "base64").account().accountId();
  const entry = new xdr.AccountEntry({
    accountId,
    balance: xdr.Int64.fromString("15000000"),
    seqNum: xdr.Int64.fromString("4000"),
    numSubEntries: 1,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    thresholds: Buffer.from([0, 0, 0, 0]),
    signers: [
      new xdr.Signer({
        key: xdr.SignerKey.signerKeyTypeEd25519(facilitator.rawPublicKey()),
        weight: 1,
      }),
    ],
    ext: new xdr.AccountEntryExt(0),
  });
  return {
    entries: [
      {
        key,
        xdr: xdr.LedgerEntryData.account(entry).toXDR("base64"),
        lastModifiedLedgerSeq: 90,
      },
    ],
    latestLedger: 100,
  };
}

/** A port nothing listens on: the connection is refused. */
const REFUSED = "http://127.0.0.1:1";

const channel = channels[0]!;
const fac = facilitator.publicKey();

describe("checkChannel over HTTP", () => {
  it("reports a channel the RPC has no entry for as missing", async () => {
    const rpc = FallbackRpc.fromUrls([await stub("no-entry")]);
    expect(await checkChannel(rpc, channel, fac)).toBe("missing");
  });

  it("accepts a channel the RPC returns with the facilitator as its signer", async () => {
    const rpc = FallbackRpc.fromUrls([await stub("entry")]);
    expect(await checkChannel(rpc, channel, fac)).toBe(undefined);
  });

  it("throws when the RPC answers 503, instead of reporting the channel missing", async () => {
    const rpc = FallbackRpc.fromUrls([await stub("503")]);
    await expect(checkChannel(rpc, channel, fac)).rejects.toThrow(/503/);
  });

  it("throws when the connection is refused, instead of reporting the channel missing", async () => {
    const rpc = FallbackRpc.fromUrls([REFUSED]);
    await expect(checkChannel(rpc, channel, fac)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("FallbackRpc account reads", () => {
  it("moves past a failing endpoint to one that says the account does not exist", async () => {
    const rpc = FallbackRpc.fromUrls([await stub("503"), await stub("no-entry")]);
    await expect(rpc.getAccountEntry(channel)).rejects.toThrow(/not found/i);
  });

  it("does not report not-found when every endpoint failed", async () => {
    const rpc = FallbackRpc.fromUrls([await stub("503"), REFUSED]);
    const error = await rpc.getAccountEntry(channel).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/not found/i);
  });

  it("reads the sequence number from the entry", async () => {
    const rpc = FallbackRpc.fromUrls([await stub("entry")]);
    expect((await rpc.getAccount(channel)).sequenceNumber()).toBe("4000");
  });
});

describe("sequence reads during an RPC outage", () => {
  /** A submitter whose account reads go over HTTP to `url`; everything else is the fake. */
  function setup(url: string) {
    const fake = new FakeRpc({ [fac]: 500n, [channel]: 1000n });
    const http = FallbackRpc.fromUrls([url]);
    Object.assign(fake, { getAccount: (a: string) => http.getAccount(a) });
    const events: SubmitterEvent[] = [];
    const submitter = new SettlementSubmitter({
      rpc: fake,
      networkPassphrase: "Test SDF Network ; September 2015",
      signer: keypairSigner(facilitator),
      channels: [channel],
      timeoutSeconds: 20,
      now: () => fake.closeTime * 1000,
      sleep: async () => {},
      onEvent: (e) => events.push(e),
    });
    return { submitter, events };
  }

  it("keeps the channel in the pool when reads fail with 503 past the time bound", async () => {
    const { submitter, events } = setup(await stub("503"));
    await expect(submitter.submit(call())).rejects.toThrow();
    expect(events.map((e) => e.type)).not.toContain("channel-quarantined");
    expect(submitter.stats()).toMatchObject({ quarantined: 0, channels: 1, busy: 0 });
  });

  it("still takes a channel the RPC has no entry for out of the pool", async () => {
    const { submitter, events } = setup(await stub("no-entry"));
    await expect(submitter.submit(call())).rejects.toThrow(/not found/i);
    expect(events.map((e) => e.type)).toContain("channel-quarantined");
    expect(submitter.stats()).toMatchObject({ quarantined: 1, channels: 0 });
  });
});

function call() {
  return {
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(
          StrKey.encodeContract(Buffer.alloc(32, 7)),
        ).toScAddress(),
        functionName: "settle_upto",
        args: [],
      }),
    ),
    auth: [],
  };
}
