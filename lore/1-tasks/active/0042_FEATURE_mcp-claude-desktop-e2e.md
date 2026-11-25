---
id: "0042"
title: "A seller that always answers in the testnet catalog, found and paid from Claude Desktop"
type: FEATURE
status: active
owner: bstruzyk
milestone: 2
related_adr: []
related_tasks: ["0037", "0032", "0041", "0063", "0137", "0026", "0044", "0069"]
tags: [mcp, dev-tools, e2e, priority-medium, effort-medium]
links: []
history:
  - date: "2026-10-13"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0037: its acceptance criterion on Claude Desktop needs a catalog a README reader
      can point at, and none exists until 0032 serves /discovery/resources.
  - date: "2026-11-25"
    status: active
    who: bstruzyk
    note: >
      Started: first put examples/http-api on a public URL and get it listed in the testnet
      catalog, then run the CLI in Claude Desktop against it.
  - date: "2026-11-25"
    status: active
    who: karolkow
    note: >
      Replanned: the run must work for any README reader on any day, so the seller stays up on our
      server instead of a tunnel; the agent searches (0137) instead of listing.
  - date: "2026-11-25"
    status: active
    who: karolkow
    note: >
      Review of the plan: the 402 must name https, the seller's check stays out of the
      facilitator's watchdog, its own network, and reset recovery is part of the task.
---

# A seller that always answers in the testnet catalog, found and paid from Claude Desktop

## Summary

Give the public testnet catalog a seller that always answers, so a reader who adds the
`stellar-x402-mcp` CLI (0037) to Claude Desktop with the README's config can search our catalog and
pay, any day.

## Context

- The CLI needs `STELLAR_X402_DISCOVERY_URL`: since 0032 our facilitator serves the catalog in
  public, `https://x402-facilitator.sorobanscan.com` (`docs/runbook.md`).
- Checked 2026-11-25: the testnet catalog holds one listing, on a `trycloudflare.com` tunnel that no
  longer resolves, and no pubnet listing. A seller run from a laptop leaves the same dead listing
  when it stops, so the seller runs on our server.
- Testnet has no outside sellers: the sellers 0155 seeds are on pubnet, and the CLI pays only on
  testnet until 0044. A demo seller on pubnet and seeding come with 0044.
- `examples/http-api` reads only `SELLER_ADDRESS` (a public account), `FACILITATOR_URL` and `PORT`,
  so the server holds no secret for it. `FACILITATOR_URL` defaults to x402.org and must name ours,
  or the payment never reaches our catalog. It has no Dockerfile yet.
- The server's tunnel is managed in Cloudflare (`--token-file`), so the seller's hostname is added
  there by whoever holds the zone; the server's owner reviews and deploys (0026).
- Behind the tunnel Express sees plain http, so without a public URL the 402 names an `http://`
  resource, which the cataloger refuses (`packages/seller-fetch/src/guard.ts`, `not_https`): the
  seller takes its public origin from the environment. The listing from 0136 was https because it
  came from the Rust seller, not this example.
- The seller gets its own Compose network with `cloudflared` only, not `edge`, and calls our
  facilitator at its public URL, so it is a client like any other.
- The watchdog restarts the facilitator when the facilitator's healthcheck fails
  (`deploy/libexec/x402-watchdog`), so the seller's check stays out of it.
- A testnet reset removes the listing, the seller's account and its trustline, and 0069 may drop a
  listing nobody pays for; keeping the listing alive is part of this task.
- 0037 proved list then pay over MCP stdio, and 0137 search then pay, both with the SDK client; this
  task is the same path in Claude Desktop against the deployed catalog.
- Dead listings are removed by 0069, not here.

## Acceptance Criteria

- [ ] `examples/http-api` runs on the production server next to the facilitator, at its own public
      https hostname, settling through our facilitator; its 402 names an `https://` resource, and it
      is listed in the testnet catalog
- [x] The README's catalog line (`apps/mcp-local/README.md`, today
      `https://your-catalog.example.com`) names our catalog's testnet URL (`8dee9c1e`)
- [ ] Given the README's config in Claude Desktop, when an agent searches the catalog, then it finds
      that seller and pays it on testnet; the transaction hash is recorded here
- [ ] A probe apart from the facilitator's healthcheck alarms when the seller stops answering a 402
      with our `payTo` on `stellar:testnet`

## Implementation Notes

### The seller, ready for the server (2026-11-25)

On this task's branch, four commits:

- `e70e086d` `PUBLIC_ORIGIN`: optional, https and an origin only; the 402 then names
  `<origin>/weather`. Unset, the seller names the URL the request came in on, as before.
- `d3733e60` the seller handles SIGTERM: it stops taking requests, lets open ones finish and
  exits 0.
- `7158f4a1` `examples/http-api/Dockerfile`, on the facilitator's pinned base.
- `8dee9c1e` the README's catalog line names `https://x402-facilitator.sorobanscan.com`.

Checked on that code:

- **The catalog's own steps** (`packages/bazaar`, as `apps/facilitator/src/catalog/cataloger.ts`
  runs them after a settle), fed the seller's real 402 with
  `PUBLIC_ORIGIN=https://x402-seller.sorobanscan.com`: the payment's copy validates, the check
  request is `GET https://x402-seller.sorobanscan.com/weather?city=Warsaw`, the seller's answer
  gives a listing with our `payTo` and 10000 (0.001 USDC), and `sameListing` with the payment's
  copy is true. Without it, behind the tunnel, the check request is http and the seller-fetch guard
  refuses it with `not_https`, so no listing is written.
- **The image**, run as the server would (`--read-only`, `--cap-drop ALL`,
  `no-new-privileges`) against our facilitator: 402 naming
  `https://x402-seller.sorobanscan.com/weather`, `stellar:testnet`, amount 10000; a probe from
  inside the container gets 402; `docker stop` returns at once with exit code 0.
- **The repo's checks:** lint, typecheck and prettier clean; tests pass in 22 of 23 packages,
  facilitator included (55 files, with the local Postgres). `deploy` fails in
  `openbao-snapshot.test.ts` and `portal.test.ts` on macOS (`flock: command not found`), the same
  two files without these commits.

### Testnet e2e run (2026-11-25)

`pnpm mcp:e2e` (`apps/mcp-local/e2e`, task 0037) on the code of `8dee9c1e`: **26 of 26 scenarios
passed, 0 failed**, 125 result rows, 188 s. It starts the seller locally without `PUBLIC_ORIGIN`, so
it proves the payment path still works after these commits, not the https listing behind the tunnel,
which only the deployed seller can show.

The three real payments of 0.001 testnet USDC, each `successful` on Horizon:

| Scenario                         | Transaction                                                        | Ledger  |
| -------------------------------- | ------------------------------------------------------------------ | ------- |
| E-21                             | `263d5b00c6f7440b28d5c3228ea9441ac205ae3729f84c2f7248752f9e74d2ba` | 5917948 |
| E-22                             | `60a8ef6d533b1ae10599c1bbac63549c82dc9ce0734a712f09279a524e8e4d67` | 5917950 |
| E-25 (search, then pay)          | `bdebcc1fe02fadf0226d821512ebb88904a6d4dda0a7fc8e15ae3128e7f280c0` | 5917955 |

Accounts, made for this run with friendbot and a USDC trustline each (Circle's faucet funded the
buyer with 20 USDC); after the run the buyer held 19.997 USDC and the seller 0.003:

- buyer `GAR7V5FFFBZCONTFJM6DM4ERFJ2YPQAGODBAGN2N5HBJKRJQ6ZQOSACM`, kept for the Claude Desktop run
- seller `GDZ5HHWORH5MRTC4CC6UY63OQMXVSM4Y7MXJ4WGGTZV2HDGMOJQP632X`, for e2e runs only; the deployed
  seller gets an account of its own

Their keys are in the owner's git-ignored `.env.e2e-testnet`, and go with the testnet reset of
2026-12-16. `apps/mcp-local/e2e/results/testnet-results.json` was left as it was: the run's commit
field would name `8f671cbe`, as these commits were not made yet.

## Design Decisions

### Emerged

1. **`PUBLIC_ORIGIN` takes https and an origin only.** An http one would bring back the refused
   listing, and a path would make the route name a URL other than its own.
2. **The seller handles SIGTERM.** Not in the criteria; without it every `docker stop` and deploy
   would wait out the grace period and kill it, which the facilitator and the portal avoid the same
   way.
