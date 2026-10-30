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
- `MAX_VALIDITY_LEDGERS` (66 by default, above `MIN_VALIDITY_LEDGERS`, at most 120): the furthest a payer's
  auth may expire after the latest ledger. `/verify` and `/settle` refuse a later one with
  `invalid_exact_stellar_signature_expiration_too_far`, whatever the resource's
  `maxTimeoutSeconds` allows. A 300 s resource signs 60 ledgers at 5 s a ledger, and upstream's
  check allows 2 more; the rest of 66 is spare. They also refuse a resource whose
  `maxTimeoutSeconds` is above the cap less a tenth at 5 s a ledger, whatever the ledger, so a
  refused payment stays refused when it comes back: **ask for a `maxTimeoutSeconds` of at most
  300** (at the default). On a day of 4 s ledgers a client signs 300 s for 75 ledgers, which the
  cap refuses. The cap bounds how long one payment can hold a channel (0073).
- `CHANNELS`: one payment holds one channel. A sent transaction that never shows up holds it
  until its ledger bound's estimated time plus 30 s (about 426 s by default, 750 s at a cap of
  120), so size the set for such stalls next to the load: with two channels, two of them make
  every new `/settle` wait for a channel until its budget ends. No metric shows a held channel
  yet (0089).
- `NETWORK=stellar:pubnet` refuses to start: `/settle` would spend there with no spend budgets
  (0024) and no fencing token on the channel lease (0071) yet.

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
- A deploy passes `DATABASE_URL` and `RPC_URLS` as files instead: `DATABASE_URL_FILE` and
  `RPC_URLS_FILE` name Compose `file:` secrets, so the values never show in `docker inspect`
  (ADR 0011). Setting a value both ways refuses to start.
- Local runs and tests: `docker compose up -d` at the repo root starts PostgreSQL on
  `127.0.0.1:15432`. `pnpm dev` applies the migrations to `DATABASE_URL` before it starts.
- `pnpm migrate` applies the pending migrations; the service never changes the schema. Run it
  before a release that adds one. `0002_success_answered`: on a database without it, a success is
  answered once per process instead of once per payment. `0003_catalog_type_seq`: without it, a
  `/discovery/resources` `type` filter scans the whole catalog. `0005_settlement_attempts` adds
  each hash's attempt state and bounds; hashes written before it fall back to the auth entry's
  expiry. `0007_settlement_reopened` adds the reopen count: rows already there, and rows an older
  release writes during the deploy, get -1 and never reopen. This release can't claim a payment
  on a database without it.
- An online migration (ADR 0012) commits step by step, so `pnpm migrate` after a stopped or
  failed run continues from the next step. It logs `migration_step` after each step and
  `migration_backfill` every 50 backfill batches. A backfill writes about 1.2 GiB of WAL per
  2 million rows and grows its table by about a third: check the disk's headroom first
  (ADR 0011).

## The channel lease

Only one process at a time settles through a network's channel set, so two never sign with the
same channel sequence numbers (AD-17, task 0025). The process that holds the lease, a row named
`<network>:channels` in the settlement store, renews it every third of `LEASE_TTL_MS` (30 s by
default).

- A process without the lease starts anyway: `/verify` and `/supported` answer, and
  `/settle` answers `503 { "error": "no_lease" }` with `Retry-After: 5`. It tries to take the
  lease every third of the TTL and never exits.
- A renewal that fails, because the store errs or another process holds the lease, stops new
  settlements at once; calls already sent run on. So does reaching the expiry the process last
  wrote. A call let in before that sends nothing: the lease is checked again once its hash is
  stored, and the call ends with `settle_exact_stellar_record_write_failed`. Logged as `lease_lost` with its `reason`, and `lease_acquired` when it holds it again;
  both counted in `lease_changes_total`.
- A process that dies keeps the lease until its TTL ends; another one takes it 5 s later, a
  margin for a holder whose clock lags. One that stops cleanly gives it up after its drain, so the
  next one takes it at its next attempt.

## `/health`

- `GET /health` is liveness: 200 while the server is up, whatever the lease or the store. The
  container healthcheck calls it (ADR 0011).
- Its body is `{ "ready": …, "listed": … }`. `ready`: the process holds the lease and isn't
  shutting down, so `/settle` serves. `listed`: a sweep has listed the open settlement records
  (0019). A deploy waits for both and rolls back without them.
- The process starts only on a schema with every migration it knows applied, and names the
  missing ones otherwise; a schema ahead of the code passes, so a rollback starts.

## Shutdown

On SIGTERM (a deploy: Docker sends it, then SIGKILL after 180 s) the process drains before it
exits:

1. `/settle` answers `503 { "error": "shutting_down" }` with `Retry-After: 5`; the server keeps
   listening, so a client gets that answer instead of a refused connection.
2. Every call that has signed nothing yet, whether waiting for a channel, prepared ahead or reading
   a sequence, ends at once with `settle_exact_stellar_shutting_down`, and its record closes
   `rejected`. Its client repeats the same payment while `extra.retryable` says so ("Nothing
   sent", below), and the repeat reaches the next process.
3. Calls already sent run on until they are final or recorded `pending`, at most their ledger
   bound (the payer's auth expiry) at the pool's estimate of 6 s a ledger, plus 30 s: about
   66 × 6 + 30 = 426 s by default, 750 s at a cap of 120. The process keeps renewing the lease
   meanwhile, and the drain ends at 150 s (below).
   Past the 150 s deadline the next process's reconciliation finishes them (0073). No new
   reconciliation sweep starts, and one under way is waited for.
4. Then nothing can send, so the lease is given up (`shutdown_drained`, `lease_released`) and the
   next process takes it at its next attempt. A sweep under way doesn't hold it up, as sweeps need
   no lease.
5. The server closes. Requests still open get 15 s, then their connections are cut, so a stalled
   client can't hold the process; then it waits for a sweep under way and exits.

A second SIGTERM or Ctrl-C joins the drain under way. A failed shutdown is logged as
`shutdown_failed` and exits with code 1.

If the drain isn't done after 150 s, open connections are cut and the lease is left to run out
(`shutdown_deadline`), and the process exits. The lease runs from its last renewal, so another
process can send on the channels about 25 s later (the TTL less up to a third of it, plus the
5 s margin), while a transaction can stay valid until its payer's auth expires (66 ledgers by default, about 5.5 minutes; at most 120, about 10 minutes,
since 0073). Until it lands or expires, the new process's sends on its channel may fail with
`txBadSeq` and rebuild; it can't be charged
twice, and the new process's reconciliation finishes its record. Fencing closes that gap (0071).
Accepted for testnet; before pubnet the new process leaves such a channel out until its record
ends (0090).

## `/settle` answers

Every outcome is a 200 with an x402 `SettleResponse`. A 400 is a malformed request. A 503 comes
from a process without the channel lease (`no_lease`) or one shutting down (`shutting_down`):
nothing was read or settled, so repeat the same request after `Retry-After`. A call that a
shutdown reaches after it started settling gets the 200 `settle_exact_stellar_shutting_down`
below instead: with no `transaction`, nothing was sent, so repeat the same payment, which the
next process settles (see "Nothing sent" below). A 500 is an error of ours, such as the
store failing: repeat the same request. Never sign a new payment because of a 500, since the first
one may still be settling.

`success: true` is answered once per payment: an earlier call got it, whoever made that call.
Every later call with the same payment gets `settle_exact_stellar_already_settled`, so one payment
unlocks one response.

| `errorReason`                                        | `transaction`           | Meaning                                                                                            | What to do                                                                                |
| ---------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `settlement_pending`                                 | the hash, or empty      | sent, not final yet; empty: not signed yet, or the store couldn't say                              | repeat the same request (see below), or look the hash up                                  |
| `settle_exact_stellar_already_settled`               | the hash                | settled; an earlier call already got this payment's success                                        | don't serve again for this payment                                                        |
| `settle_exact_stellar_nonce_already_used`            | the stored hash, if any | this payer's nonce is already used by another payment, in whatever state                           | refuse: the payment isn't for this request                                                |
| `settle_exact_stellar_timeout`                       | —                       | the settle budget ran out before anything was signed; nothing was or will be                       | repeat the same payment while `extra.retryable` (see below)                               |
| `settle_exact_stellar_interrupted`                   | —                       | the facilitator restarted before anything was signed; nothing was or will be                       | repeat the same payment while `extra.retryable` (see below)                               |
| `settle_exact_stellar_shutting_down`                 | an earlier hash, if any | the facilitator was stopping; nothing was applied, and nothing more will be sent                   | repeat the same payment while `extra.retryable` (see below)                               |
| `settle_exact_stellar_rpc_unavailable`               | an earlier hash, if any | no RPC endpoint answered (refused, failed or timed out)                                            | repeat the same payment while `extra.retryable` (see below)                               |
| `settle_exact_stellar_no_channel_in_time`            | —                       | every channel was busy until the deadline                                                          | repeat the same payment while `extra.retryable` (see below)                               |
| `settle_exact_stellar_no_channels`                   | —                       | every channel is out of the pool                                                                   | repeat the same payment while `extra.retryable` (see below)                               |
| `settle_exact_stellar_transaction_signing_failed`    | an earlier hash, if any | the facilitator's key couldn't sign the transaction (OpenBao down, sealed or refusing)             | repeat the same payment while `extra.retryable` (see below)                               |
| `settle_exact_stellar_fee_bump_signing_failed`       | an earlier hash, if any | the facilitator's key couldn't sign the fee bump                                                   | repeat the same payment while `extra.retryable` (see below)                               |
| `settle_exact_stellar_fee_exceeds_maximum`           | an earlier hash, if any | the network fee rose above the facilitator's ceiling                                               | sign a new payment and try again later                                                    |
| `settle_exact_stellar_signature_expiration_too_soon` | an earlier hash, if any | the auth expires before the pool could land it                                                     | sign a new payment with a longer `maxTimeoutSeconds`                                      |
| `settle_exact_stellar_simulation_failed`             | an earlier hash, if any | the settlement's simulation failed, e.g. the payer's balance                                       | check the payer, then sign a new payment                                                  |
| `settle_exact_stellar_unexpected_balance_changes`    | an earlier hash, if any | the transaction moves something other than the one payment                                         | refuse: the payment is malformed                                                          |
| `settle_exact_stellar_record_write_failed`           | an earlier hash, if any | a new envelope wasn't sent: its hash couldn't be stored, the budget ran out, or the lease was lost | sign a new payment                                                                        |
| a spend reason from the facilitator's limits         | —                       | the facilitator's spend limits refused it                                                          | sign a new payment later; this one is ended                                               |
| `settle_exact_stellar_refused`                       | —                       | the spend-limit check failed with an error of ours                                                 | sign a new payment, and tell us                                                           |
| `settle_exact_stellar_transaction_failed`            | the hash                | included in a ledger, but failed                                                                   | sign a new payment                                                                        |
| `settle_exact_stellar_transaction_submission_failed` | the hash                | refused by the network before inclusion                                                            | sign a new payment                                                                        |
| `settle_exact_stellar_transaction_expired`           | the hash                | not included before its ledger bound, the payer's auth expiry; before 0073, its 60 s time bound    | sign a new payment                                                                        |
| `invalid_exact_stellar_*`, `invalid_network`         | —                       | the `/verify` checks, rerun by `/settle`, refused the payment                                      | fix the payment; for `invalid_exact_stellar_payload_fee_exceeds_maximum`, try again later |
| `unexpected_settle_error`                            | an earlier hash, if any | an error of ours after the claim                                                                   | sign a new payment, and tell us                                                           |

"An earlier hash, if any": a refusal after a `txBadSeq` rebuild carries the last stored hash.
`transaction` is the last stored hash; it may never have reached the network.

A failure with no `transaction` sent nothing. `settlement_pending` and the "nothing sent" answers
below are worth repeating as they are. Any other failure gets the same answer again, so a retry
needs a new payment (a new nonce), except for:

- a refusal from the checks (`invalid_exact_stellar_*`, `invalid_network`) comes before the
  claim and records nothing: the same payment may be sent again, and may succeed later.
  `invalid_exact_stellar_payload_fee_exceeds_maximum` is our own fee estimate above our ceiling,
  not a fault in the payment (0086: it can settle after its payer signed again, so ask for a new
  signature only once it can't land). `invalid_exact_stellar_signature_expiration_too_far` comes
  from our three checks: the resource's `maxTimeoutSeconds` above 300 s at the default cap ("at
  most 300 is allowed", which stays refused, so the resource must ask for less), the auth's own
  expiry past the cap ("at most 66 are allowed": the client saw ledgers faster than 5 s; the
  refused payment may pass later too, so ask for a new signature only once it can't land), or
  past the last ledger the pool can bound. Upstream's own expiry check answers with it too, for
  one whose message names none of these, when our RPC is 3 or more ledgers behind the client's;
- a spend refusal the store couldn't record leaves the payment claimed, so a repeat after the
  budget gets `…_timeout` instead of the spend reason.

**Nothing sent** (task 0073). `…_timeout`, `…_interrupted`, `…_shutting_down`,
`…_rpc_unavailable`, `…_no_channel_in_time`, `…_no_channels` and the two `…_signing_failed`
(task 0036) with no `transaction` mean nothing
was sent, but the payer's signed auth entry can still land until its expiration ledger, by
whoever holds the payment. Signing a new payment then could charge the payer twice, so these
answers carry `extra`:

- `retryable: true` and `expirationLedger`: repeat the same payment, as it is, while the latest
  ledger is at most `expirationLedger - 2` (the pool needs 2 ledgers left). The facilitator runs
  the `/verify` checks again and reopens the record, so the payment settles once; a different
  payment on the same nonce still gets `…_nonce_already_used`. A payment that no longer passes
  the checks (a balance spent meanwhile) gets their refusal, and the record stays as it was. A
  `…_timeout` given during the checks, before anything was claimed, is repeated the same way.
- `retryable: true` when the facilitator couldn't read the latest ledger: repeating the same
  payment is always safe, but stop once the network is past `expirationLedger`, then sign a new
  payment.
- `retryable: false` with 1 ledger left: too late for the facilitator, but the auth entry is
  valid in its expiration ledger, so whoever holds the payment may still land it. Wait until
  that ledger has closed, then sign a new payment.
- `retryable: false` once the expiration ledger has closed: sign a new payment.

The same answer with a `transaction` (an earlier hash) is never reopened: sign a new payment.
Each reopen is logged as `settlement_reopened` with the earlier reason and counted in
`settlement_reopened_total` by that `reason`; the record's `reopened` column counts them. While a
deploy replaces a release from before task 0073, the old process answers these reasons without
`extra`, as "sign a new payment". That answer holds: a record it claimed, before or during the
deploy, has `reopened` -1 and never reopens, and this release answers it the same way, without
`extra`. A rollback to a release before 0073 takes the "repeat it" promise back: it answers a
repeat from the record, as "sign a new payment", and doesn't reopen it.

A `pending` record is finished by reconciliation (task 0019): the pool's late result, or a sweep
that asks the network about each of the record's hashes. A hash the network doesn't know turns
`…_transaction_expired` only once its ledger bound, the payer's auth expiry, has passed (for a
hash signed before 0073, its 60 s time bound), so a repeat may get
`settlement_pending` for up to that long. A record expires only if no hash was stored since the
sweep read them: a rebuild in flight makes it wait for the next sweep. A sweep runs as the server
starts and then 10 s after each one ends, beside `/settle`, in every process, with or without the channel lease; a record the
RPC or the store couldn't check is simply tried by the next sweep. A claim with no hash is closed
as `…_interrupted` once its settle budget plus 5 s has passed.

The RPC keeps only a window of history (testnet's keeps 120960 ledgers, about 7 days; providers
differ). A record claimed before the oldest ledger it keeps can't be told from one that never
landed, so it stays open, is logged once as `settlement_history_gone` (counted in
`settlement_history_gone_total`) and is checked again every 5 minutes: check its hashes on a
block explorer or Horizon before acting on it.

A success answered while the store was down is marked answered once the store is back. After a
restart the process can't know it answered one, so a repeat may get that payment's success a
second time, at most once; no money moves twice.

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
