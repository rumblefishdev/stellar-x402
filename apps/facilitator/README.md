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
- `NETWORK=stellar:pubnet` refuses to start until a deploy can't reuse a channel left open (0090),
  pubnet's callers present an API key (0105), each key's settlements count in a fee budget of its
  own (0107), a failing signer raises an alarm (0027) and the hot key's reach is decided again
  (0048). The spend budgets bound the loss, but self-payments from many cheap addresses
  can still use up the shared budgets for every seller (see "Shared budgets used up by
  self-payments" below).

## Callers and rate limits

Every route is open on testnet: no caller authenticates, and an API key is ignored. On pubnet
`/verify` and `/settle` will require one, issued by our portal after Discord sign-in (0105, 0106;
pubnet is refused until then). `/verify`
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
  one cloud NAT share its address the same way. On testnet this stays so, since a key is ignored
  there (0060); on pubnet a caller will be counted by its API key (0105).
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

## Spend budgets and breakers

The facilitator pays every fee (AD-10), so `/settle` checks what each settlement may cost before
it sends anything (AD-18, [ADR 0007](../../docs/adr/0007-fee-abuse-containment.md), task 0024).
In order, after the claim:

1. **The balance floor.** The fee account's spendable balance (its balance minus the reserve and
   selling liabilities, which no fee can draw on) is read every `SPEND_BALANCE_INTERVAL_MS`.
   Below `SPEND_FLOOR_STROOPS`, or before the first reading, `/settle` refuses with
   `settle_exact_stellar_facilitator_underfunded`. A failed read keeps the last value, but only
   for 10 intervals, at least 5 minutes: past that the floor fails closed, so about 5 minutes of
   RPC trouble refuse every `/settle` with a funded account. The logs say
   `facilitator_underfunded` (error) and `facilitator_funded` (info) on each crossing, and
   `facilitator_balance_stale` (error) and `facilitator_balance_fresh` (info) when the reading
   goes stale and when a read refreshes it.
2. **The breakers.** The payer's, the `payTo`'s and, for a wasm token, the asset's.
3. **The budgets.** The fee ceiling (`MAX_FEE_STROOPS`) is reserved against every budget that
   applies, all or none. Once the record is final the reservation is lowered to the fee charged,
   or released when nothing was charged.

All of it lives in PostgreSQL (`spend_reservations`, `spend_scopes`), so every instance shares it.
A store that doesn't answer within the settle budget refuses the settlement
(`settle_exact_stellar_spend_store_unavailable`): it fails closed.

### Limits

Every budget sums the fees of one rolling window, `SPEND_WINDOW_MS` (24 h). A known asset is a
configured SAC: USDC on its network. Every other token, a self-issued SAC as much as a wasm token,
is an other asset: anyone can mint one, so it gets the low tier. This limits spend, not acceptance:
any SEP-41 token still settles.

| Setting                         | Default     | XLM | Budget                                                                                                |
| ------------------------------- | ----------- | --- | ----------------------------------------------------------------------------------------------------- |
| `SPEND_GLOBAL_STROOPS`          | 500 000 000 | 50  | every settlement                                                                                      |
| `SPEND_PER_PAYER_STROOPS`       | 20 000 000  | 2   | one payer in the known assets together, and again in each other asset                                 |
| `SPEND_PER_PAY_TO_STROOPS`      | 100 000 000 | 10  | one `payTo` in the known assets together, and again in each other asset                               |
| `SPEND_PER_ASSET_STROOPS`       | 250 000 000 | 25  | one known asset                                                                                       |
| `SPEND_PER_ASSET_OTHER_STROOPS` | 20 000 000  | 2   | one other asset                                                                                       |
| `SPEND_TIER_OTHER_STROOPS`      | 100 000 000 | 10  | every other asset together, so junk tokens can't use up `global`                                      |
| `SPEND_FLOOR_STROOPS`           | 50 000 000  | 5   | not a budget: `/settle` refuses while the fee account can spend less (ADR 0013)                       |
| `SPEND_BALANCE_INTERVAL_MS`     | 30 000      |     | how often the fee account's balance is read; a reading 10 intervals old (at least 5 min) fails closed |
| `SPEND_WINDOW_MS`               | 86 400 000  |     | the window of every budget                                                                            |

Every stroops value is a whole number from 1 to the int64 maximum, and every budget is at least
`MAX_FEE_STROOPS`: a settlement reserves the fee ceiling, so a smaller budget would refuse every
payment, and the facilitator refuses to start with one. `global` stays below the
100 XLM float less its 25 XLM alarm, so one window can't empty the fee account. The defaults are
the same on testnet and at the pubnet start. `BREAKER_FAILURES` and `BREAKER_COOLDOWN_MS` are no
longer read; a leftover one refuses to start, like `STORE`.

### Breakers

A breaker counts only failures the network included and charged, against whoever caused them.
A SAC's code is the host's, so a SAC asset never has one. Refusals before the submit, timeouts,
rejected and expired transactions count nowhere. Neither does a payment whose nonce was already
used: someone holding the payload, the seller say, submitted it first. A C-account payer's breaker
opens at once only when the failure is in its own contract (its `__check_auth`); its other
failures, auth errors raised elsewhere included, take 3. The `payTo` is blamed only when a known
asset's SAC refuses the transfer on the recipient's side; in another token whoever issued it could
stage that, so the payer is blamed. Like the budgets, the payer's and the `payTo`'s breakers are
keyed by tier: one for the known assets, one per other asset.

| Breaker                            | Opens at                                                  | Window | First opening | Then | At most |
| ---------------------------------- | --------------------------------------------------------- | ------ | ------------- | ---- | ------- |
| payer (per known or other asset)   | 3 failures; 1 failure in a C-account payer's own contract | 1 h    | 1 h           | ×4   | 24 h    |
| `payTo` (per known or other asset) | 3 failures                                                | 1 h    | 1 h           | ×4   | 24 h    |
| wasm asset                         | 5 failures, and at least as many failures as successes    | 10 min | 10 min        | ×2   | 6 h     |

After a breaker closes, the next failure it is blamed for opens it again at the next step. A day
without an opening clears that. `/verify` refuses too while a breaker is open, so a seller doesn't
serve a payment `/settle` would refuse. If the store can't be read there, `/verify` answers as if
no breaker were open and logs `spend_store_failed`; `/settle` checks again. Budgets are not
checked at `/verify`, since it spends nothing.

The policy is fixed in code (`src/spend/policy.ts`), not config.

### What a seller sees when a budget refuses

`/settle` answers 200 with `success: false` and one of the reasons in "`/settle` answers": the
payment is ended and nothing was sent. A spend reason names the narrowest budget that is full,
never an address, an amount or a reset time. What to do:

- `…_spend_limit_payer`: that buyer has used its budget for the window. Ask it to pay again later.
- `…_spend_limit_pay_to`: your `payTo`'s budget in this asset is full. It counts the fees of
  every payment to you, so other parties paying you, Sybil payers among them, can fill it as well
  as your own traffic. Wait for the window to roll, or ask the operator for a higher limit; a
  payment in another asset counts against a budget of its own.
- `…_spend_limit_asset`, `…_spend_limit_other`: the asset, or all other tokens together, have.
  Offer USDC, or another asset.
- `…_spend_limit_global`: the facilitator has. Wait, or use another facilitator.
- `…_breaker_open_*`: settlements for that payer, `payTo` or token failed on chain too often. The
  breaker closes on its own later; until then, use another asset or wait.

`…_spend_store_unavailable` and `…_facilitator_underfunded` are different: they are transient, so
they don't end the payment. They answer `extra.retryable`, and the same payment, repeated as it
is, settles once the store or the balance is back ("Nothing sent", under "`/settle` answers").

The window rolls: a budget frees up as the oldest fees in it pass 24 h, not all at once.

### Shared budgets used up by self-payments

Per-payer and per-`payTo` budgets bound one address, but addresses are free. Someone who pays
themself 1-unit USDC payments from many addresses (about 13 payers and 3 `payTo`s at the defaults)
can fill `asset:USDC` in about 17,000 payments. Each payer has one payment in flight at a time,
so 13 payers take about two hours; about 50 payers and 50 channels take half an hour. Every payment
succeeds, so no breaker opens, and USDC is then refused for every seller until the window rolls.
The loss stops at 25 XLM for USDC and 10 XLM for other tokens per window. That bounds the rate,
not the sum: an attack kept up for under three days takes the float from 100 XLM to its 5 XLM floor,
and `facilitator_underfunded` then refuses every payment until a top-up. This is accepted on
testnet. On pubnet callers will present API keys with fee budgets of their own (0105, 0107): see
the threat model, "Shared budget exhaustion by Sybil self-payments".

The signal is `spend_budget_nearing` (warn, counted in `spend_budget_nearing_total{budget}`) at
80 %. It fires for every budget; for this attack, watch `asset`, `other` and `global`. Then:

1. Look at the settlements of the last hours: the `settled` log lines name each payer, and the
   `settlements` table holds each payment's `payTo` and amount (`payment_requirements`). An attack
   looks like many new payers paying few `payTo`s in 1-unit amounts. Real traffic looks like many
   `payTo`s and the prices their resources ask.
2. If it is real traffic, raise the budget (`SPEND_PER_ASSET_STROOPS`, or `SPEND_GLOBAL_STROOPS`)
   and restart. A higher budget is a higher worst-case loss per window: keep `global` below the
   float less its alarm, and top up the float to match.
3. If it is an attack, raising the budget only raises what it costs us. Leave it: the window rolls
   and the budget frees up once the payments stop. Tell sellers who ask to wait or use another
   facilitator. If it goes on for more than a day, watch the float: at up to 35 XLM a day it
   reaches ADR 0013's alarm at 25 XLM in about two days, and the floor in under three.

### Metrics and logs

Labels come from closed sets; addresses are in log lines only.

- `spend_refused_total{reason}`: every refusal, by reason.
- `spend_budget_nearing_total{budget}`, `budget` being `global`, `payer`, `pay_to`, `asset` or
  `other`; log `spend_budget_nearing` with the scope, at most once per scope in 15 minutes.
- log `spend_limit_reached` (info) with the settlement key and the budget's scope, for each
  refusal by a budget.
- `spend_breaker_opened_total{breaker}`; log `spend_breaker_opened` with the scope and its end.
- `spend_failure_attributed_total{fault}`: `payer`, `pay_to`, `asset` or `ours`. Log
  `spend_failure_ours` (warn) with the failure cause, for a failure charged to us, and
  `spend_asset_kind_unconfirmed` (warn) for a failure blamed on a token whose kind couldn't be
  read: it opens no asset breaker, since a SAC must never get one.
- `spend_store_failures_total{op}` (`breaker`, `reserve`, `release`); log `spend_store_failed`.
- `spend_commit_unmatched_total{state}`; log `spend_commit_unmatched` (error): a fee was paid that
  counts against no budget.
- `balance_read_failures_total`; log `balance_read_failed`. Logs `facilitator_underfunded`
  (error) and `facilitator_funded` (info) when the balance crosses the floor, and
  `facilitator_balance_stale` (error) and `facilitator_balance_fresh` (info), as above.

## The signer

- The facilitator key signs only in OpenBao Transit, over a unix socket (ADR 0013). No secret seed
  reaches the service, and a leftover `FACILITATOR_SECRET` is refused at startup.
- `FACILITATOR_ADDRESS`: the key's own account, the fee account and every channel's signer.
  `OPENBAO_SOCKET`, `OPENBAO_KEY`, `OPENBAO_KEY_VERSION`: the socket, the Transit key and its pinned
  version. `OPENBAO_ROLE_ID`, `OPENBAO_SECRET_ID`: the AppRole login; a deploy passes both as files
  (`_FILE`). All required.
- Tests and local runs use a fake OpenBao on a unix socket, `test/fake-openbao.ts`.
  `LOCAL_KEY_SECRET=S… pnpm dev:openbao` starts it for `pnpm dev` and prints the settings to export;
  the key must stay the same, since channels name it as their signer.

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
  on a database without it. `0011_settlement_in_flight`: `/settle` can't claim a payment without it.
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
  wrote. A call let in before that sends nothing: the lease is checked again before and after its
  hash is stored, and the call ends with `settle_exact_stellar_lease_lost`. Logged as `lease_lost`
  with its `reason`, and `lease_acquired` when it holds it again; both counted in
  `lease_changes_total`.
- Every acquire gives the lease a new token, a renewal keeps it, and a hash is stored only under
  the lease's current token (task 0071). So a process that froze past its TTL (a VM pause, a long
  GC) while another took over stores nothing and sends nothing once it wakes: its call ends with
  `settle_exact_stellar_lease_lost`. The process's own expiry usually stops the call first, with
  no line for that call; `settlement_lease_fenced` and `settlement_lease_fenced_total` show only
  a call the store refused. `settlement_outcomes_total` counts every `…_lease_lost`. What it had
  already sent still finishes, by itself or by the new holder's reconciliation. An envelope stored
  and checked before the freeze can still go out after a takeover, one per call in flight, and
  the send loop has no lease check: it resends that envelope until its bound, at most the
  `MAX_VALIDITY_LEDGERS` cap (about 6.5 minutes by default). Every resend has the same hash, so
  it lands at most once. At worst the new holder gets a `txBadSeq` on that channel and rebuilds,
  and reconciliation finishes the record.
- A renewal never waits on a hash being stored; a takeover or a release does, for that one write
  (the lease row is locked `FOR KEY SHARE`, and `token` is unique).
- While a deploy replaces a release from before task 0071, a takeover by the old process keeps
  the token, so it doesn't fence the new one's earlier calls, and the old process doesn't reopen
  a `…_lease_lost` record: a repeat that reaches it gets that answer again, without `extra`. Wait
  for the deploy to finish and repeat the same payment then.
- A process that dies keeps the lease until its TTL ends; another one takes it 5 s later, a
  margin for a holder whose clock lags. One that stops cleanly gives it up after its drain, so the
  next one takes it at its next attempt.

## `/health`

- `GET /health` is liveness: 200 while the server is up, whatever the lease or the store. The
  container healthcheck calls it (ADR 0011).
- Its body is `{ "ready": …, "signer": …, "listed": … }`. `ready`: the process holds the lease and
  isn't shutting down, so `/settle` serves. `listed`: a sweep has listed the open settlement records
  (0019). A deploy waits for both and rolls back without them. `signer`: `unchecked`, `ok` or
  `failed`, from the check after start and each signature since (0036); only a deploy waits for it.
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
`txBadSeq` and rebuild; it can't be charged twice, and the new process's reconciliation finishes
its record. Fencing (0071) stops the old process from sending anything new after the takeover,
not what it had already sent. Accepted for testnet; before pubnet the new process leaves such a
channel out until its record ends (0090).

## `/verify` answers

`/verify` passes on upstream's `invalid_exact_stellar_*` reasons, plus the checks of its own.

While a breaker is open (task 0024, "Breakers" above), a payment every other check accepted gets
`/settle`'s reason early, so a seller doesn't serve what `/settle` would refuse. `invalidMessage`
says which breaker, with no address, amount or reset time:

| `invalidReason`                            | meaning                                            | what to do                                   |
| ------------------------------------------ | -------------------------------------------------- | -------------------------------------------- |
| `settle_exact_stellar_breaker_open_payer`  | the payer's settlements failed on chain too often  | the buyer waits, or pays in another asset    |
| `settle_exact_stellar_breaker_open_pay_to` | settlements to `payTo` failed on chain too often   | wait, and check what fails with the operator |
| `settle_exact_stellar_breaker_open_asset`  | this token's settlements failed on chain too often | offer another asset                          |

After upstream's `invalid_exact_stellar_payload_simulation_failed` it simulates once more, to
name the one cause upstream drops:

| `invalidReason`                                 | meaning                                                                     | what to do                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| `invalid_exact_stellar_payto_trustline_missing` | `payTo` holds no trustline to the classic asset, or the account is unfunded | the seller funds the account and adds it            |
| `invalid_exact_stellar_payer_trustline_missing` | the payer holds no trustline to the classic asset                           | the payer makes sure the account exists and adds it |

`invalidMessage` names the account, the asset and the ledger the simulation saw, and the `verified`
and `settled` logs carry it as `message`. The token must be a Stellar Asset Contract: any
contract can emit the same error, and only a SAC's means a trustline. A SAC stops at its first
failure, the payer's side first, so the payer's message adds that `payTo` wasn't checked: a seller
missing one too shows up on the next try. Once the trustline is there, the same payment may be
sent again until its auth expires. `/settle`'s check before the claim gives the same two reasons; a
trustline removed after it answers `settle_exact_stellar_simulation_failed` from the pool.

Every other failure keeps upstream's reason. So does a lookup that fails or takes over 3 s, logged
as `trustline_lookup_failed`, a muxed `payTo`, because the error names its G-address, and a payload
without exactly one auth entry of the payer's, which gets no lookup: it is free to send, and the
lookup costs RPC calls.

Upstream's client simulates before it signs, so its users get the same `Error(Contract, #13)` from
the client and never reach `/verify`. These answers are for a client that builds its own payload,
and for a trustline removed after signing.

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

| `errorReason`                                        | `transaction`           | Meaning                                                                                              | What to do                                                                                  |
| ---------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `settlement_pending`                                 | the hash, or empty      | sent, not final yet; empty: not signed yet, or the store couldn't say                                | repeat the same request (see below), or look the hash up                                    |
| `settle_exact_stellar_already_settled`               | the hash                | settled; an earlier call already got this payment's success                                          | don't serve again for this payment                                                          |
| `settle_exact_stellar_nonce_already_used`            | the stored hash, if any | this payer's nonce is already used by another payment, in whatever state                             | refuse: the payment isn't for this request                                                  |
| `settle_exact_stellar_timeout`                       | —                       | the settle budget ran out before anything was signed; nothing was or will be                         | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_payer_busy`                    | —                       | another payment from this payer in this asset is settling; nothing was recorded for this one         | send the same payment again                                                                 |
| `settle_exact_stellar_interrupted`                   | —                       | the facilitator restarted before anything was signed; nothing was or will be                         | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_shutting_down`                 | an earlier hash, if any | the facilitator was stopping; nothing was applied, and nothing more will be sent                     | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_rpc_unavailable`               | an earlier hash, if any | no RPC endpoint answered (refused, failed or timed out)                                              | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_no_channel_in_time`            | —                       | every channel was busy until the deadline                                                            | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_no_channels`                   | —                       | every channel is out of the pool                                                                     | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_lease_lost`                    | an earlier hash, if any | this process lost the channel lease before it sent; another process holds it, or none does           | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_transaction_signing_failed`    | an earlier hash, if any | the facilitator's key couldn't sign the transaction (OpenBao down, sealed or refusing)               | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_fee_bump_signing_failed`       | an earlier hash, if any | the facilitator's key couldn't sign the fee bump                                                     | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_fee_exceeds_maximum`           | an earlier hash, if any | the network fee rose above the facilitator's ceiling                                                 | after `extra.expirationLedger` (see below), sign a new payment                              |
| `settle_exact_stellar_signature_expiration_too_soon` | an earlier hash, if any | the auth expires before the pool could land it                                                       | sign a new payment with a longer `maxTimeoutSeconds`, as below                              |
| `settle_exact_stellar_simulation_failed`             | an earlier hash, if any | the settlement's simulation failed, e.g. the payer's balance                                         | check the payer, then sign a new payment as below                                           |
| `settle_exact_stellar_unexpected_balance_changes`    | an earlier hash, if any | the transaction moves something other than the one payment                                           | refuse: the payment is malformed; any corrected one as below                                |
| `settle_exact_stellar_payer_not_authorized`          | an earlier hash, if any | the payment's auth was never used by the token: its `transfer` doesn't require the payer's signature | sign a new payment in another asset, as below                                               |
| `settle_exact_stellar_record_write_failed`           | an earlier hash, if any | a new envelope wasn't sent: its hash couldn't be stored, or the budget ran out                       | sign a new payment after `extra.expirationLedger` (see below)                               |
| `settle_exact_stellar_spend_limit_payer`             | —                       | this payer used its fee budget for the window                                                        | the buyer waits, then signs a new payment as below                                          |
| `settle_exact_stellar_spend_limit_pay_to`            | —                       | fees of payments to this `payTo`, whoever paid, filled its budget                                    | wait, or ask the operator for a higher limit; a new payment as below                        |
| `settle_exact_stellar_spend_limit_asset`             | —                       | this asset used its fee budget for the window                                                        | sign a new payment in another asset, as below                                               |
| `settle_exact_stellar_spend_limit_other`             | —                       | all tokens but the known ones used their shared fee budget                                           | sign a new payment in a known asset (USDC), as below                                        |
| `settle_exact_stellar_spend_limit_global`            | —                       | the facilitator used its fee budget for the window                                                   | wait, or use another facilitator; a new payment as below                                    |
| `settle_exact_stellar_breaker_open_payer`            | —                       | this payer's settlements failed on chain too often                                                   | the buyer waits, then signs a new payment as below                                          |
| `settle_exact_stellar_breaker_open_pay_to`           | —                       | settlements to this `payTo` failed on chain too often                                                | wait, and check what fails with the operator                                                |
| `settle_exact_stellar_breaker_open_asset`            | —                       | this token's settlements failed on chain too often                                                   | sign a new payment in another asset, as below                                               |
| `settle_exact_stellar_spend_store_unavailable`       | —                       | the spend store didn't answer in time; nothing was sent                                              | repeat the same payment while `extra.retryable` (see below)                                 |
| `settle_exact_stellar_facilitator_underfunded`       | —                       | the facilitator's fee account is below its floor, or its balance couldn't be read for minutes        | repeat the same payment later, while `extra.retryable` (see below); the operator tops it up |
| `settle_exact_stellar_refused`                       | —                       | the spend check failed with an error of ours                                                         | sign a new payment as below, and tell us                                                    |
| `settle_exact_stellar_transaction_failed`            | the hash                | included in a ledger, but failed                                                                     | sign a new payment after `extra.expirationLedger` (see below)                               |
| `settle_exact_stellar_transaction_submission_failed` | the hash                | refused by the network before inclusion                                                              | sign a new payment after `extra.expirationLedger` (see below)                               |
| `settle_exact_stellar_transaction_expired`           | the hash                | not included before its ledger bound, the payer's auth expiry; before 0073, its 60 s time bound      | sign a new payment                                                                          |
| `invalid_exact_stellar_*`, `invalid_network`         | —                       | the `/verify` checks, rerun by `/settle`, refused the payment                                        | fix the problem; for `invalid_exact_stellar_payload_fee_exceeds_maximum`, see notes below   |
| `unexpected_settle_error`                            | an earlier hash, if any | an error of ours after the claim                                                                     | sign a new payment as below, and tell us                                                    |

"An earlier hash, if any": a refusal after a `txBadSeq` rebuild carries the last stored hash.
`transaction` is the last stored hash; it may never have reached the network.

A failure with no `transaction` sent nothing. `settlement_pending` and the "nothing sent" answers
below are worth repeating as they are. Any other failure gets the same answer again, so a retry
needs a new payment (a new nonce), but only once this one can't land ("Ended", below), except for:

- a refusal from the checks (`invalid_exact_stellar_*`, `invalid_network`) comes before the
  claim and records nothing: the same payment may be sent again, and may succeed later, except
  when its message names archived entries.
  `invalid_exact_stellar_payload_fee_exceeds_maximum` is our own fee estimate above our ceiling,
  not a fault in the payment (0086: it can settle after its payer signed again, so ask for a new
  signature only once it can't land). With the bid from fee stats (no `INCLUSION_FEE_STROOPS`),
  the bid adds at most 20,000 stroops of it (fee stats are capped at 10,000 and the estimate
  counts the bid twice), so rent is what usually puts it there, and waiting seldom helps. When the
  message names archived entries
  (`the payment's transaction lists N archived entries to restore: <LedgerKey XDR>, …`), restore
  them and sign a new payment once this one can't land ([below](#restoring-archived-entries)); one
  that names none may still touch archived state its transaction doesn't list.
  `invalid_exact_stellar_signature_expiration_too_far` comes from our three checks: the resource's
  `maxTimeoutSeconds` above 300 s at the default cap ("at most 300 is allowed", which stays
  refused, so the resource must ask for less), the auth's own expiry past the cap ("at most 66 are
  allowed": the client saw ledgers faster than 5 s; the refused payment may pass later too, so ask
  for a new signature only once it can't land), or past the last ledger the pool can bound.
  Upstream's own expiry check answers with it too, for one whose message names none of these,
  when our RPC is 3 or more ledgers behind the client's;
- `…_payer_busy` recorded nothing: one payer's payments in one asset settle one at a time, and
  this one waited for another until the budget ran out. Send the same payment again;
- a spend refusal the store couldn't record leaves the payment claimed, so a repeat after the
  budget gets `…_timeout` instead of the spend reason.

**Nothing sent** (task 0073). `…_timeout`, `…_interrupted`, `…_shutting_down`,
`…_rpc_unavailable`, `…_no_channel_in_time`, `…_no_channels`, `…_lease_lost` (task 0071),
the two `…_signing_failed` (task 0036), `…_spend_store_unavailable` and
`…_facilitator_underfunded` (task 0024) with no `transaction` mean nothing was sent, but the
payer's signed auth entry can still land until its expiration ledger, by
whoever holds the payment. Signing a new payment then could charge the payer twice, so these
answers carry `extra`:

- `retryable: true` and `expirationLedger`: repeat the same payment, as it is, while the latest
  ledger is at most `expirationLedger - 2` (the pool needs 2 ledgers left). The facilitator runs
  the `/verify` checks again and reopens the record, so the payment settles once; a different
  payment on the same nonce still gets `…_nonce_already_used`. A payment that no longer passes
  the checks (a balance spent meanwhile) gets their refusal, after this same advice, and the record
  stays as it was, so a later repeat may still settle it (task 0082). A
  `…_timeout` given during the checks, before anything was claimed, is repeated the same way.
- `retryable: true` when the facilitator couldn't read the latest ledger: repeating the same
  payment is always safe, but stop once the network is past `expirationLedger`, then sign a new
  payment.
- `retryable: false` with 1 ledger left: too late for the facilitator, but the auth entry is
  valid in its expiration ledger, so whoever holds the payment may still land it. Wait until
  that ledger has closed, then sign a new payment.
- `retryable: false` once the expiration ledger has closed: sign a new payment.

The same answer with a `transaction` (an earlier hash) is never reopened: see "Ended" below. Each
reopen is logged as `settlement_reopened` with the earlier reason and counted in
`settlement_reopened_total` by that `reason`; the record's `reopened` column counts them. While a
deploy replaces a release from before task 0073, the old process answers these reasons without
`extra`, as "sign a new payment" (and one from before task 0071 doesn't reopen `…_lease_lost`).
That answer holds: a record it claimed, before or during the deploy, has `reopened` -1 and never
reopens, and this release answers it the same way, without `extra`. A rollback to a release
before 0073 takes the "repeat it" promise back: it answers a repeat from the record, as "sign a
new payment", and doesn't reopen it.

`…_lease_lost` with a `transaction` means the record has that hash, so it doesn't reopen. Either
the lease was found lost right after the hash was stored, and that envelope was never sent, or an
envelope was sent and refused with `txBadSeq` and the lease went before its rebuild.

**Ended** (task 0082). Every other answer that ended a payment says when a new signature is safe:
the refusals after the claim, `…_transaction_failed`, `…_transaction_submission_failed` and a
"nothing sent" reason with a `transaction`. The payer's auth entry can still land in a new envelope until its expiration ledger, by whoever holds the payment: a failed
or refused transaction doesn't use its nonce. So these answers carry `extra.retryable: false` and
`extra.expirationLedger`, and `errorMessage` names that ledger:

- until the expiration ledger has closed, or when the latest ledger couldn't be read: don't sign a
  new payment yet, it could charge the payer twice;
- once it has closed: sign a new payment.

Both carry the same `extra`, so a client that doesn't read `errorMessage` signs again once the
network's latest ledger is at least `expirationLedger`. A repeat gets the same answer, worked out
from the ledger of that moment.

A record claimed before task 0073 answers every reason without `extra`, as "sign a new payment".
For a record claimed since, `…_transaction_expired` comes only after the expiry, so it says nothing
more. While a deploy replaces a release from before task 0082, and after a rollback to one, these
reasons are answered without `extra` too: the wait still holds, and the client reads the expiry from
the auth entry it signed.

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
block explorer or Horizon before acting on it. It can't land again past its bound, so the sweep
frees its payer's slot in that asset (task 0024): the payer's other payments in that asset settle
as usual, and the record stays open for the operator.

`settlement_landed_after_expired` (counted in `settlement_landed_after_expired_total` by `state`)
reports a transaction found on chain after its record ended `expired`, with its hash and ledger. The
record stays `expired`. With `state` `success` the payer was told to sign a new payment for one that
landed: check the hash, and whether a second payment followed. With `failed` no money moved. It
fires only while a confirmation is still running: nothing reads an `expired` hash again, so a wrong
`expired` from `confirm()` or from a sweep with no confirmation running isn't reported, and a zero
doesn't prove there were none.

A success answered while the store was down is marked answered once the store is back. After a
restart the process can't know it answered one, so a repeat may get that payment's success a
second time, at most once; no money moves twice.

### Restoring archived entries

A payment that touches archived state (the token's instance or code, a non-SAC balance, a
C-account's SAC balance) restores it and pays the restore rent, which the facilitator won't pay
above its fee ceiling (task 0066). The refusal's message names the entries as base64 `LedgerKey`
XDR, at most four (`and N more` after them); a key over 512 characters is shown as
`a key of N characters`, and the payment's own simulation gives it. The list is the one the
payment was built with, as the buyer's client put it in the transaction: the facilitator names
only persistent contract data and code from it, but doesn't check that they are archived or that
they are the token's. Check both before paying their rent, since otherwise you pay for entries
the buyer chose:

- whose: the key says it. For a data entry,
  `Address.fromScAddress(key.contractData().contract()).toString()` must be the token's contract
  (`asset` in the requirements), which holds its instance and its balances; for a code entry,
  `key.contractCode().hash()` must be the Wasm hash the token's instance names.
- archived: `server.getLedgerEntries(...keys)` returns each entry with its `liveUntilLedgerSeq`;
  one below the latest ledger (`server.getLatestLedger()`), or 0, is no longer live.

Any funded account can restore them, all in one transaction. The snippet is for testnet; on
pubnet use `Networks.PUBLIC` and a mainnet RPC URL:

```ts
import {
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  rpc,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const source = Keypair.fromSecret(process.env.SECRET!); // pays the restore
const keys = ["AAAABg…"].map((k) => xdr.LedgerKey.fromXDR(k, "base64")); // from the message

const restore = new TransactionBuilder(await server.getAccount(source.publicKey()), {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.restoreFootprint({}))
  .setSorobanData(new SorobanDataBuilder().setReadWrite(keys).build())
  .setTimeout(60)
  .build();
const prepared = await server.prepareTransaction(restore); // adds the restore rent to the fee
prepared.sign(source);
const sent = await server.sendTransaction(prepared);
if (sent.status !== "PENDING") throw new Error(`restore not accepted: ${sent.status}`);
const result = await server.pollTransaction(sent.hash);
if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
  throw new Error(`restore ${sent.hash}: ${result.status}`);
}
```

Then sign a new payment, not the same one again: its auth may have expired, and a new one is
built from a new simulation, so it lists only the entries still archived, if any. Ask for it
only once the refused payment can't land: the fee check simulates again, so after the restore
that payment can pass too, next to the new one (0086).

stellar-cli restores one entry per call, and takes the parts of a key rather than the
`LedgerKey`: an instance with `stellar contract restore --id <contract>`, code with
`--wasm-hash <hash>` (`key.contractCode().hash().toString("hex")`), and a data entry with
`--id <contract> --key-xdr <ScVal>` (`key.contractData().key().toXDR("base64")`), where
`key = xdr.LedgerKey.fromXDR(k, "base64")` for a key `k` from the message.

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
