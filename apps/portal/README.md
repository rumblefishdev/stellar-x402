# portal

The backend of the facilitator's API keys (task 0106): the pubnet key that `/verify` and `/settle`
require on `stellar:pubnet` (0105) is issued, shown and revoked here. There is no sign-in, no
session and no cookie. The API hub (`sorobanscan.com/api/hub`) signs members in, and calls this
backend with a short token that names the account and the one thing it may do. No browser reaches
it, so it sends no CORS header.

## The four calls

Every call carries `Authorization: Bearer <token>`. The hub's token is `v1.<payload>.<mac>`: an
HMAC-SHA-256 over its own context (`sorobanscan-hub/x402-token/v1`) and the payload, so a token the
hub signed for another product doesn't pass here. Its claims are `iss` (`https://sorobanscan.com/api/hub`),
`aud` (`x402`), `sub` (`discord:<id>`), `act`, `jti`, `iat` and `exp`, and it lives 60 seconds at
most. Each route takes one `act` only; a token for another one is refused.

| Route                         | `act`    | Answer                                                                                                 |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `GET /api/hub/v1/account`     | `read`   | `{ key: { state, … }, details: { showable } }`; `state` is `none`, `active` or `revoked`               |
| `POST /api/hub/v1/key/reveal` | `reveal` | `{ key_id, value, created_at }`: the key                                                               |
| `POST /api/hub/v1/key/revoke` | `revoke` | `{ revoked: true, revoked_at, next_eligible_at }`; the key stops working at once                       |
| `POST /api/hub/v1/key/issue`  | `issue`  | `{ outcome, next_eligible_at? }`, always a 200: `issued`, `has_key`, `capped`, `too_young` or `failed` |
| `GET /health`                 | none     | 200 when the database answers, 503 when it doesn't; one query answers every call for 2 s               |

What `account` holds: `key_id` (the first 12 hex digits of the key's hash), `created_at` and
`can_issue` for an active key; `revoked_at`, `next_eligible_at` (only while a new key waits) and
`can_issue` for a revoked one; only `can_issue: true` for none. `showable` is false for a key with
no copy (one the operator's script issued) and for one whose copy doesn't open.

### Errors

An error is `{ code, message, details? }`.

| Status | `code`               | When                                                                                       |
| ------ | -------------------- | ------------------------------------------------------------------------------------------ |
| 401    | `invalid_token`      | no bearer, or a token that isn't the hub's for `x402` and for now                          |
| 403    | `action_not_allowed` | the token's `act` isn't the route's                                                        |
| 404    | `no_key`             | `reveal` or `revoke` for an account with no active key                                     |
| 404    | `key_revoked`        | `reveal` after a revoke this month; `details` has `next_eligible_at`, `revoked_at`         |
| 404    | `not_found`          | a path or method the contract doesn't have (only GET and POST), before any token is read   |
| 409    | `key_not_viewable`   | `reveal` for a key with no copy that opens; revoke it for a new one                        |
| 429    | `rate_limited`       | over a limit below; `Retry-After` says when                                                |
| 502    | `key_unavailable`    | the database failed on `account`, `reveal` or `revoke`; the answer never holds its message |
| 500    | `internal`           | anything else that went wrong in the backend                                               |

`key_unavailable` is a 502, as Prices answers it: the hub calls again at once after a 503 only.
`issue` never answers 502: when the database fails it is a `200` with `outcome: failed`.

### Limits

- **A new key after a revoke waits for the next calendar month (UTC).** An account can have one
  key, revoke it, and has no other until the 1st. `issue` answers `capped` with `next_eligible_at`.
- **`too_young`** when the account's Discord id says it is younger than `MIN_ACCOUNT_AGE_MINUTES`,
  with `next_eligible_at`. Whether the account is in Stellar Developers and has cleared screening is
  the hub's to prove before it signs a token for `issue`; nothing here asks Discord.
- **Rate limits**, in memory, per minute: 30 by address for calls whose token doesn't verify (the
  address is the socket's, or Cloudflare's header with `CLIENT_IP=cloudflare`; an IPv6 one counts by
  its /56, as the facilitator's limits do), and 60 by account for those that do.

## What is kept

- **The registry** (`api_keys`): a key's SHA-256, its owner (`discord:<id>`) and its state, as for
  every key. One active key per owner; a revocation holds from the facilitator's next request.
- **A sealed copy** (`api_key_copies`) lets `reveal` show the key again: AES-256-GCM under
  `KEY_ENCRYPTION_KEY`, which the database never holds, bound to the owner and the hash so a copy
  moved to another row doesn't open. It is deleted when the key is revoked. A database dump alone
  gives no key; the dump and the encryption key together give every active key the backend issued.
- **Nothing else.** No token is stored and the hub's secret is not in the database.

The schema is the facilitator's: this backend runs no migration and refuses to start on a database
without `api_keys` and `api_key_copies`.

## Logs

One JSON object per line on stdout. A call is named by the token's `jti` and `act`; a key by
`key_id`, the first 12 hex digits of its hash. Never a key, a token, a secret or a Discord id, and
`listening` carries the port only. Which to act on:

| Event                                                           | Level | Means                                                                            |
| --------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `startup_failed`                                                | error | bad settings or no database or tables; the process exits                         |
| `hub_call_failed`, `pool_error`, `not_ready`                    | error | the database failed: act on a run of these                                       |
| `hub_key_copy_unreadable`                                       | error | a copy exists and doesn't open: the wrong `KEY_ENCRYPTION_KEY`, or a damaged row |
| `hub_call_refused` (`invalid_token`, `action_not_allowed`)      | warn  | the hub's token was refused: a bad secret or clock, or a stranger                |
| `hub_strangers_limited`                                         | warn  | one address (an IPv6 /56) is over its limit; once per window                     |
| `hub_key_issued`, `hub_key_revealed`, `hub_key_revoked`         | info  | the key events                                                                   |
| `hub_issue_refused`, `hub_reveal_refused`, `hub_revoke_refused` | info  | what a call came to, with an `outcome`; not faults                               |
| `hub_account_answered`                                          | info  | the state `account` gave                                                         |
| `listening`                                                     | info  | started                                                                          |

A call with no bearer at all is logged at `debug` only, and `not_ready` once every 2 s at most,
however often `/health` is called.

## Settings

| Setting                   | What it is                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `HUB_TOKEN_SECRET`        | JSON `{"current": "<base64>", "previous": "<base64>"}`, each 32 bytes in standard padded base64; `previous` is optional |
| `KEY_ENCRYPTION_KEY`      | 32 bytes in base64: seals the copies; losing it loses every copy. Must differ from the hub's secret                     |
| `DATABASE_URL`            | the database whose registry the facilitator reads                                                                       |
| `MIN_ACCOUNT_AGE_MINUTES` | default `5`                                                                                                             |
| `PORT`                    | default `4022`                                                                                                          |
| `CLIENT_IP`               | `socket` (default) or `cloudflare`                                                                                      |
| `LOG_LEVEL`               | `debug`, `info` (default), `warn` or `error`                                                                            |

A token verifies under `current` or `previous`. The backend reads the secret only when it starts,
so it is changed in the runbook's four steps ("Changing the token's secret" in
[`docs/runbook.md`](../../docs/runbook.md), under "The portal's backend"), whose order keeps every
key the hub may sign with accepted; each of their two restarts fails the hub's calls for a few
seconds.

`DATABASE_URL`, `KEY_ENCRYPTION_KEY` and `HUB_TOKEN_SECRET` can each be given as a file instead,
`<NAME>_FILE`, as a deploy does. A bad setting stops the start, naming the setting and never its
value.

## Running it locally

```sh
docker compose up -d                               # the repo's PostgreSQL, at 127.0.0.1:15432
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:15432/postgres
export KEY_ENCRYPTION_KEY=$(openssl rand -base64 32)
export HUB_TOKEN_SECRET="{\"current\":\"$(openssl rand -base64 32)\"}"
pnpm --filter @stellar-x402/facilitator exec tsx src/migrate.ts
pnpm --filter @stellar-x402/portal dev             # http://localhost:4022
```

A token for a call by hand comes from `signHubToken` in `src/hub-token.ts` (built into `dist`),
signed with the same secret.

`test/live/hand-run.sh` does all of this against a scratch schema and walks the four calls with
tokens it signs: `/health`, a call with no bearer and a bad one (401), then `account`, `issue`,
`account`, `reveal`, `revoke` and `issue` again (capped), then SIGTERM and exit 0. It drops the
schema when it ends and prints each step's status, never a key or a token. Build first
(`pnpm --filter @stellar-x402/portal build`); it takes `DATABASE_URL` (default as above) and `PORT`.
