---
id: "0105"
title: "Require an API key on pubnet's /verify and /settle"
type: FEATURE
status: active
owner: akot
milestone: 2
related_adr: ["0007"]
related_tasks: ["0024", "0060", "0077", "0106", "0107"]
tags: [facilitator, security, before-pubnet, priority-high, effort-medium, platform]
links:
  - ../../../docs/adr/0007-fee-abuse-containment.md
history:
  - date: "2026-11-03"
    status: backlog
    who: akot
    note: "Spawned from 0024: the team chose API keys on pubnet over keyless /settle."
  - date: "2026-11-13"
    status: active
    who: akot
    note: "Work starts."
---

# Require an API key on pubnet's /verify and /settle

## Summary

On `stellar:pubnet`, `/verify` and `/settle` answer only a caller with a known API key; on
testnet a key is ignored and every route stays open (decided by akot, 2026-11-03, ADR 0007's
amendment of that date). 0024's budgets bound the loss but not availability: self-payments from
free addresses can fill the shared `asset:USDC` budget and refuse every seller's USDC (0024's
[S-design](../archive/0024_FEATURE_spend-budgets-and-breakers/notes/S-design.md), "Residual
risk"). A key costs a Discord account in the Stellar Developers server (0106) and gets a budget of
its own (0107), so that attack no longer reaches the callers with keys. `stellar:pubnet` is refused
until this task and 0107 land, as well as 0090.

## Implementation

- A key registry in PostgreSQL: the SHA-256 hash of each key, never the key; its owner (the
  Discord account from 0106); `active` or `revoked`. One active key per owner.
- The key arrives as `Authorization: Bearer <key>`; upstream's `HTTPFacilitatorClient` sends
  per-route headers through `createAuthHeaders`, so a seller patches nothing.
- Pubnet: `/verify` and `/settle` without a key answer 401 `missing_api_key`, with an unknown or
  revoked one 401 `invalid_api_key`, before any check, and create no counter. `/supported` and
  `/discovery/*` stay open.
- Testnet: the header isn't read at all, not even as a rate-limit key, so testnet answers as it
  does today and the T1 gate's proxy (0028) needs nothing.
- On pubnet the rate limiter keys a caller by its key, not its IP (AD-11).
- The owner travels to the spend policy, which budgets by it (0107).
- The rule follows the request's network, not `NETWORK` (0077 decided one service, the network
  chosen per request; its code is 0126).
- A script for the operator to issue and revoke a key by hand, over the same registry the portal
  writes (0106).
- Docs: the facilitator README ("Callers and rate limits"), AD-11, the threat model.

## Decisions to make here

Both made by akot on 2026-11-13: "Design Decisions", 1 and 2.

## Acceptance Criteria

- [x] Given a pubnet request to `/verify` or `/settle` without a key, or with an unknown or revoked
      one, when it arrives, then it gets 401 with nothing verified or settled and no counter made
      (`api-key-route.test.ts`, "without an active key")
- [x] Given a pubnet request with an active key, when the limiter keys it, then it counts under the
      key's owner, and the spend policy gets the key's owner (`api-key-route.test.ts`, "with an
      active key"; `settle.test.ts`, "hands beforeSubmit the request's caller"). Reworded from
      "counts under the key": decision 3
- [x] Given a testnet request with or without a key, when it arrives, then it is answered as before
      this task (`api-key-route.test.ts`, "stellar:testnet takes no API key", on a process that
      serves testnet and on one that serves pubnet)
- [x] Given the registry, when a key is stored, then only its hash is kept (`keys.test.ts`, "issues
      an operator a key"; `postgres.test.ts`, "0013_api_keys: the table refuses…")

## Implementation Notes

- **Registry.** Port `ApiKeyStore` (`ports/api-key-store.ts`): `ownerOf(hash)`, `issue`, `revoke`,
  `list`. Migration `0013_api_keys`, transactional: a new table, so the release before it keeps
  working. `PostgresApiKeyStore` reads on the rate limiter's pool and writes on the main one.
- **Way in.** `http/admit.ts` replaces the limiter and the body parser in front of `/verify` and
  `/settle`: body, then the network it names, then the key and the owner's count, or the IP's
  count. `http/api-key.ts` holds the key's form, its hash and `requiresApiKey`. `rate-limit.ts`
  is split into `rateLimiter` (`byIp`, `byOwner`) and the `rateLimit` middleware `/discovery`
  still uses.
- **Owner to the spend policy.** `Settle` takes a fourth argument, `caller`, and
  `BeforeSubmitContext.caller` carries it. The policy budgets as before; 0107 reads it.
- **Script.** `keysMain` in `main.ts`, entry `src/keys.ts`, `pnpm keys issue|revoke|list`. Run by
  hand against a scratch schema of the local database, 2026-11-13: issue, a refused second issue,
  list, revoke, and the table held the hash only.
- **Docs.** The facilitator README ("Callers and rate limits", "API keys on pubnet"), AD-11, the
  threat model ("API keys", seven entries), ADR 0007's amendment of 2026-11-13, ADR 0012.
- **Tests.** `pnpm test`, 2026-11-13: 20 of 20 tasks, the facilitator 1120 tests (3 skipped),
  108 of them new, on `@x402` 2.31.0 after the rebase onto 0145. `pnpm typecheck` passes.
- **Testnet run**, 2026-11-13, at `1e6507ab`: `test/live/api-key-smoke.ts`, 11 of 11 checks
  (`test/live/results/api-key-smoke-testnet.json`). A facilitator built by `main()`, payments from
  upstream's client, a key issued and revoked by the script. Three payments of 0.0001 XLM settled
  on testnet, each counted under the IP: with no header
  `099755d39fedfb7410ea6a9ce56dd308f1711a555d7f2e11d5a2a41154881cf2`, with a made-up key
  `d545e0a81ad6830f1e1683d4154b8b2f68919e93f110bdec93fcd2fd518079d2`, with the registered key
  `f5f895f711f413fa184c53811e7988f33a47db9e03af0b45c656c2c1c8ed7077`. A request naming
  `stellar:pubnet` got 401 without a key and with a made-up one, counting nowhere; with the key it
  reached the real verifier (`invalid_network`, this process serves testnet) and counted under
  the owner; after the revocation, 401. A pubnet settlement itself can't be run until the process
  serves pubnet.

**Modified tests:**

- `settle-route.test.ts`, "answers 200 with a success body…": the settler is now called with a
  fourth argument, `undefined` on testnet. Intended: the signature grew.
- `main.test.ts`, "answers /verify with the real verifier…": its payment named `stellar:pubnet`
  to get `invalid_network` from the real verifier; such a request is now a 401, so it names
  `stellar:futurenet`. Intended: decision 7.
- `config.test.ts`, `main.test.ts`: the pubnet refusal's message no longer names 0105.
- `postgres.test.ts`: the lists of migrations a run applies gain `0013_api_keys`.

## Issues Encountered

- **0077's code doesn't exist.** The task and its brief assumed one process serving both
  networks. 0077 closed with its docs and moved the code to 0126: the process serves `NETWORK`,
  and `NETWORK=stellar:pubnet` is refused at startup. See decisions 4 and 6.
- **A timing test failed once.** `settle.test.ts`, "keeps a repeat waiting past the settle
  timeout…", in the block 0074 lists as failing under load, failed in the first full `pnpm test`
  beside 19 other packages and passed alone, three times in its file, and in the second full run.
- **`pnpm lint` at the root reports 904 errors**, all in `packages/sdk/rust/target/doc`, a local,
  git-ignored rustdoc build. `eslint apps packages/metrics-catalog` is clean.

## Design Decisions

### From Plan

Decided by akot on 2026-11-13, before any code.

1. **A revocation holds from the next request, with no cache.** The registry is read on every
   request that needs a key, one primary-key lookup. The limiter already writes to the store on
   every request, 0106 asks for "at once", and `/verify` answers from every instance, where a
   cache would keep a leaked key working.
2. **The registry is one table, `api_keys`**: `key_hash` (primary key), `owner`, `state`,
   `created_at`, `revoked_at`, and a partial unique index on `owner` for the active rows, so the
   database holds "one active key per owner" whoever writes. A revoked key keeps its row. A plain
   SHA-256: a key is 32 random bytes. An owner's limits are left to 0107.
3. **An owner is `<kind>:<id>`, and the limiter counts by it, not by the key.** `operator:<name>`
   from the script, `discord:<id>` from 0106. From stellar-prices-api, which has no registry of its
   own (AWS API Gateway holds its keys): AWS counts per key, so there a replaced key waits for the
   next quota period. Counted by owner, a replaced key continues the count, and the spend policy
   gets the same identity. The second criterion said "counts under the key" and was reworded.
4. **The rule follows the request's network, and `/verify` and `/settle` read the body before
   they count, in every process.** The network is in the body, so three things can't all hold in
   a process that serves both networks: testnet counted before the body is read, a pubnet 401
   that makes no counter, and pubnet counted by key. Considered: the IP limiter first for
   everyone (a 401 would count, and sellers behind one address would share a budget again), and
   the rule by `NETWORK` until 0126 (pubnet only ever runs in the process that serves both,
   ADR 0011, so that order would never run in production). The new order applies to today's
   testnet process too, so it carries real traffic before pubnet does. A client over its budget
   now costs a parse of at most 64 KiB where it cost nothing.
5. **A key is `x402_` and 43 base64url characters**, shown once.

### Emerged

6. **Pubnet behaviour is tested on an app whose config has the network set by hand.**
   `parseConfig` refuses pubnet, so `api-key-route.test.ts` sets `network` on the parsed config.
   The refusal's message drops 0105 and keeps 0090, 0107, 0027 and 0048.
7. **A request that names `stellar:pubnet` needs a key on today's testnet process too.** It got
   200 `invalid_network`, counted by IP; it now gets a 401. That follows from decision 4, and no
   testnet request changes.
8. **Two refusals.** No `Authorization` header is `missing_api_key`; any header that isn't
   `Bearer` and an active key is `invalid_api_key`, the same for a key never issued and a revoked
   one. A key of the wrong form is refused without a read. Both carry RFC 6750's
   `WWW-Authenticate`.
9. **The registry is read on the rate limiter's pool.** It is read before a request is let in,
   as the counter is, and a flood of made-up keys must not take settlement's connections.
10. **The caller is not stored with the settlement.** It travels to `beforeSubmit` only. `onFinal`
    gets the record, and a reservation keeps its own scopes, so 0107 can commit or release an
    owner's budget without it. The `verified` and `settled` log lines carry it as `caller`.
11. **The table checks what the adapter checks**: 64 hex digits in `key_hash`, an owner of at most
    128 characters in `a-z`, `0-9`, `_`, `-` after its kind, and `revoked_at` set exactly when the
    state is `revoked`. The owner is part of a rate-limit key, so its form is bounded.
12. **The script issues only `operator:` owners and has no rotate.** `issue` refuses an owner that
    has an active key, so replacing one is `revoke`, then `issue`. `revoke` takes any owner, a
    portal's too. The production compose file gets no service for it: there is no pubnet database
    to point it at until 0126.
13. **A key's owner has the same rate budgets as an IP**, `RATE_LIMIT_VERIFY` and
    `RATE_LIMIT_SETTLE`. No new setting.
14. **`http_requests_total` lists status 401.** Outside the catalog's list the EMF line would
    write it as `other` and report an unknown value. No alarm reads it.
15. **A request refused for its key is unthrottled, and that is written down, not fixed.** It
    follows from "no counter" in the first criterion. The threat model's "Requests without a
    valid key, in bulk" has the cost and why counting by IP is worse.
16. **ADR 0007 has an amendment and ADR 0012 two notes**, beyond the docs the task lists: the
    decisions above change what ADR 0007 says about the limiter, and 0012 lists each database's
    tables and the open question on the limiter's counters, which this task narrows.

## Future Work

- A compose service for the key script on pubnet: noted in 0126, which adds pubnet's services.
- An alarm or a count of the 401s: none today (decision 14). Not spawned; to decide with akot.
