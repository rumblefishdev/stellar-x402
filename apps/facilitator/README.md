# apps/facilitator

The x402 facilitator for Stellar: `/verify` and `/settle` for the `exact` scheme, and the
discovery routes. Design: [the M1 spine](../../docs/architecture/m1-spine.md) (AD-3, AD-6, AD-22),
[ADR 0006](../../docs/adr/0006-settlement-record.md) (the settlement record) and
[ADR 0011](../../docs/adr/0011-facilitator-hosting.md) (the settle budget and its timing).

## Settings that shape `/settle`

- `SETTLE_BUDGET_MS` (30 s by default, 1–80 s): the longest one `/settle` call takes, the checks
  and the wait for a channel included. It stays below the seller's own 90 s timeout.
- `SETTLE_TIMEOUT_MS` (20 s, or the budget when that is shorter; at least 1 s, at most the
  budget): how long a repeat of a sent payment waits for it to turn final.
- `NETWORK=stellar:pubnet` refuses to start: `/settle` would spend there
  with no spend budgets (0024) and no channel lease (0025) yet.

## Callers and rate limits

Every route is open: no caller authenticates, and there are no API keys (task 0060). `/verify`
and `/settle` send no CORS headers, so a browser page can't call them; a seller's server calls
them for its buyers.

Each client has a budget per route and window. Past it the route answers 429
`{"error":"too_many_requests"}` with `Retry-After` in seconds; the other routes still answer.
Every request counts, a malformed or oversized one too. `/supported` has no limit.

| Setting                | Default  | Meaning                                                                             |
| ---------------------- | -------- | ----------------------------------------------------------------------------------- |
| `RATE_LIMIT_WINDOW_MS` | 60 000   | the window, aligned to the clock: every count starts again at its end               |
| `RATE_LIMIT_VERIFY`    | 600      | `/verify` requests per window and client                                            |
| `RATE_LIMIT_SETTLE`    | 600      | `/settle` requests per window and client; at least `/verify`'s                      |
| `RATE_LIMIT_DISCOVERY` | 120      | `/discovery/*` requests per window and client                                       |
| `BODY_LIMIT_BYTES`     | 65 536   | a larger request body is a 413                                                      |
| `CLIENT_IP`            | required | `cloudflare`: the `CF-Connecting-IP` header; `socket`: the connection's own address |

- **A client is its IP**, an IPv6 one its /56. The seller's server calls `/verify` and `/settle`
  for all of its buyers, so a budget is a budget per seller: a seller above about 10 paid requests
  a second needs higher values. `/settle`'s budget is never below `/verify`'s, since the seller
  settles after serving: a payment refused there was work given away. The spend budgets (AD-18),
  not these, bound the fees the facilitator pays.
- **Sellers on Cloudflare Workers share one budget.** A Worker's request to another Cloudflare
  zone arrives with `CF-Connecting-IP: 2a06:98c0:3600::103` for every Worker, and sellers behind
  one cloud NAT share its address the same way. A per-seller budget needs API keys (0060).
- **`CLIENT_IP` is required**, so it can't be forgotten behind the tunnel, where every client
  would share the tunnel's address and one budget. `cloudflare` reads `CF-Connecting-IP`, which
  Cloudflare sets on every request and refuses from a client; `socket` takes the connection's own
  address, for runs with no proxy in front (local runs and tests). Any other value refuses to
  start, and so does a leftover `TRUSTED_PROXY_HOPS`. `X-Forwarded-For` is never read: a client
  can put any address in it.
- **With `cloudflare`, a request without the header, or with anything but one address in it,** is a
  500 and an error log line: only `cloudflared` should reach the service.
- **Windows are aligned to the clock**, so a client can send up to twice its budget across a
  window's end, and every blocked client is released at the same moment.
- **The counters live in the store** (`rate_limits`). A store error is a 500,
  logged. A client over its budget is answered from the process until its window ends, without a
  store write.

## The store

- Every store is PostgreSQL, tests included. A leftover `STORE` is refused at startup.
- `DATABASE_URL`: a `postgres://` URL, required.
- Local runs and tests: `docker compose up -d` at the repo root starts PostgreSQL on
  `127.0.0.1:15432`. `pnpm dev` applies the migrations to `DATABASE_URL` before it starts.
- `pnpm migrate` applies the pending migrations; the service never changes the schema. Run it
  before a release that adds one. `0002_success_answered`: on a database without it, a success is
  answered once per process instead of once per payment. `0003_catalog_type_seq`: without it, a
  `/discovery/resources` `type` filter scans the whole catalog.
- An online migration (ADR 0012) commits step by step, so `pnpm migrate` after a stopped or
  failed run continues from the next step. It logs `migration_step` after each step and
  `migration_backfill` every 50 backfill batches. A backfill writes about 1.2 GiB of WAL per
  2 million rows and grows its table by about a third: check the disk's headroom first
  (ADR 0011).

## `/settle` answers

Every outcome is a 200 with an x402 `SettleResponse`. A 400 is a malformed request. A 500 is an
error of ours, such as the store failing: repeat the same request. Never sign a new payment
because of a 500, since the first one may still be settling.

`success: true` is answered once per payment: an earlier call got it, whoever made that call.
Every later call with the same payment gets `settle_exact_stellar_already_settled`, so one payment
unlocks one response.

| `errorReason`                                        | `transaction`           | Meaning                                                                        | What to do                                                                                |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `settlement_pending`                                 | the hash, or empty      | sent, not final yet; empty: not signed yet, or the store couldn't say          | repeat the same request (see below), or look the hash up                                  |
| `settle_exact_stellar_already_settled`               | the hash                | settled; an earlier call already got this payment's success                    | don't serve again for this payment                                                        |
| `settle_exact_stellar_nonce_already_used`            | the stored hash, if any | this payer's nonce is already used by another payment, in whatever state       | refuse: the payment isn't for this request                                                |
| `settle_exact_stellar_timeout`                       | —                       | the settle budget ran out before anything was signed; nothing was or will be   | sign a new payment                                                                        |
| `settle_exact_stellar_rpc_unavailable`               | an earlier hash, if any | no RPC endpoint answered (refused, failed or timed out)                        | sign a new payment and try again later                                                    |
| `settle_exact_stellar_no_channel_in_time`            | —                       | every channel was busy until the deadline                                      | sign a new payment and try again later                                                    |
| `settle_exact_stellar_no_channels`                   | —                       | every channel is out of the pool                                               | sign a new payment and try again later                                                    |
| `settle_exact_stellar_fee_exceeds_maximum`           | an earlier hash, if any | the network fee rose above the facilitator's ceiling                           | sign a new payment and try again later                                                    |
| `settle_exact_stellar_signature_expiration_too_soon` | an earlier hash, if any | the auth expires before the pool could land it                                 | sign a new payment with a longer `maxTimeoutSeconds`                                      |
| `settle_exact_stellar_simulation_failed`             | an earlier hash, if any | the settlement's simulation failed, e.g. the payer's balance                   | check the payer, then sign a new payment                                                  |
| `settle_exact_stellar_unexpected_balance_changes`    | an earlier hash, if any | the transaction moves something other than the one payment                     | refuse: the payment is malformed                                                          |
| `settle_exact_stellar_record_write_failed`           | an earlier hash, if any | a new envelope wasn't sent: its hash couldn't be stored, or the budget ran out | sign a new payment                                                                        |
| a spend reason from the facilitator's limits         | —                       | the facilitator's spend limits refused it                                      | sign a new payment later; this one is ended                                               |
| `settle_exact_stellar_refused`                       | —                       | the spend-limit check failed with an error of ours                             | sign a new payment, and tell us                                                           |
| `settle_exact_stellar_transaction_failed`            | the hash                | included in a ledger, but failed                                               | sign a new payment                                                                        |
| `settle_exact_stellar_transaction_submission_failed` | the hash                | refused by the network before inclusion                                        | sign a new payment                                                                        |
| `settle_exact_stellar_transaction_expired`           | the hash                | not included before its time or ledger bound                                   | sign a new payment                                                                        |
| `invalid_exact_stellar_*`, `invalid_network`         | —                       | the `/verify` checks, rerun by `/settle`, refused the payment                  | fix the payment; for `invalid_exact_stellar_payload_fee_exceeds_maximum`, try again later |
| `unexpected_settle_error`                            | an earlier hash, if any | an error of ours after the claim                                               | sign a new payment, and tell us                                                           |

"An earlier hash, if any": a refusal after a `txBadSeq` rebuild carries the last stored hash.
`transaction` is the last stored hash; it may never have reached the network.

A failure with no `transaction`, other than `settlement_pending`, sent nothing. The same payment
gets the same answer again, so a retry needs a new payment (a new nonce); only
`settlement_pending` is worth repeating as is. Three exceptions:

- a `…_timeout` the budget gave before the payment was claimed, during the checks, recorded
  nothing: the same payment may be sent again as it is, or a new one signed;
- a refusal from the checks (`invalid_exact_stellar_*`, `invalid_network`) comes before the
  claim and records nothing: the same payment may be sent again, and may succeed later.
  `invalid_exact_stellar_payload_fee_exceeds_maximum` is our own fee estimate above our ceiling,
  not a fault in the payment;
- a spend refusal the store couldn't record leaves the payment claimed, so a repeat after the
  budget gets `…_timeout` instead of the spend reason.

Until 0019 nothing finishes a `pending` record: every repeat of it gets `settlement_pending`.
The record stays `pending` across restarts. Look the hash up on chain instead of repeating for
long.

## `/discovery/resources`

`GET /discovery/resources` lists the catalog in upstream's `DiscoveryResourcesResponse`:
`{ x402Version: 2, items, pagination: { limit, offset, total } }`, in a stable order with no
ranking. `total` counts every entry the filters match.

- Filters: `type`, `payTo`, `network`, `extensions` and `scheme`, alone or combined. A
  well-formed network we don't serve, such as `eip155:8453` or the other Stellar network, any
  `scheme` but `exact` and any `extensions` but `bazaar` give an empty page. Every entry has
  `bazaar`.
- `limit`: 20 by default, at most 100. A larger one is clamped, and `pagination.limit` echoes the
  limit used. `limit=0` gives `total` alone.
- `offset`: at most 1 000 000, so every entry can be paged to.
- An empty value counts as absent: `?type=` doesn't filter.
- `400 { error: "bad_request", param }` names the parameter: `limit` or `offset` not plain digits
  or `offset` above 1 000 000, a repeated parameter, a value over 256 characters or with a control
  character, a `network` that isn't CAIP-2, or a known name written otherwise (`type[]`, `payto`,
  `Type`).
- Other parameters are ignored, so a client that sends a newer filter still gets a page.

### What gets listed

A settlement whose payload carries `extensions.bazaar` adds or refreshes an entry. The catalog
lists only resource URLs a buyer can reach, on every network (task 0054, ADR 0008): `https` or
`http` with a public DNS name. An IP literal, `localhost`, a single-label name, a private or
special-use suffix (`.local`, `.internal`, `.home`, `.test`, `.example`, …) or an
`mcp://tool/<name>` URL is left out. The payment settles as usual and `/settle` answers success;
only the listing is dropped, and the response's `EXTENSION-RESPONSES` header says `rejected` with
the reason `resource_not_public`. That is not an error in the request: the service works, it just
isn't listed. A malformed URL is `invalid_resource_url`. The rule applies to writes from this
version on: a local catalog written before it keeps its old entries until `docker compose down -v`.

| Setting              | Default | Meaning                                                                    |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `CATALOG_LIST_LOCAL` | `false` | `true` lists those URLs too, for a local run or the e2e gate; testnet only |
