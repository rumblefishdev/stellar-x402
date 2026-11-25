---
title: "How stellar-prices-api counts its quota"
type: research
status: mature
tags: [api-keys, quota, prices-api]
history:
  - date: "2026-11-23"
    status: mature
    who: akot
    note: "Read-only research in stellar-prices-api at 998ad044 and the hub at f8c07bf (agent report)."
---

# How stellar-prices-api counts and enforces its monthly quota

Read-only research, 2026-11-23, in `~/Projects/stellar-prices-api` at `998ad044`
(plus a glance at the hub, `~/Projects/sorobanscan-api-portal` at `f8c07bf`).
Paths are relative to the Prices repo unless marked "hub:". "PA" = `packages/prices-api/src`.

**The short version:** Prices has no counter of its own. API Gateway counts and
enforces the quota through usage plans, per `(usage plan, API key)`. Prices reads
AWS's figures for the dashboard and adds one rule of its own: a new key after a
revoke waits for the next calendar month (UTC), so a revoke can't reset the counter.

## 1. What is counted, where, and how

- **Requests** to the keyed `/v1` routes, **per key**, not per account. Counted by
  AWS API Gateway against the key's usage plan: "quota is scoped to `(usagePlanId,
  apiKeyId)` and counted by AWS, so there is no accounting of our own to store"
  (PA/portal/keys/gateway.rs:5-14; PA/portal/usage/mod.rs:49-52).
- **No table, no cache of its own for the counter.** "There is no database, and that
  is the design" (PA/portal/keys/mod.rs:35-42). The registry task 0190 was
  cancelled (docs/epics/self-service-onboarding.md:295 ff.).
- **Increment:** done by the gateway on every request it lets through; Prices never
  increments. Measured: a request refused for quota does **not** increment `used`
  (lore/1-tasks/archive/0180_.../notes/R-apigw-namequery-quota-and-disable.md:239-241).
  Not documented: whether a gateway-cache hit is counted before the cache lookup
  (docs/runbooks/manual-api-key-tier.md:649-652, "our inference").
- **Reading:** `GetUsage` per key gives daily `[used, remaining]` buckets; Prices sums
  them (PA/portal/keys/gateway.rs:980, `summarize_days` :1116, which restarts the sum
  where `remaining` rises, i.e. at a reset). The figures lag enforcement by minutes
  (PA/portal/usage/mod.rs:73-80), so every answer carries `as_of`.
- **Dashboard cache:** in Lambda memory, per caller (Discord id), 60 s TTL; a stale
  answer is kept 15 min and served with its original `as_of` when AWS throttles
  (PA/portal/usage/mod.rs:84-92, :139, :150). Issue/revoke evict it (:223-260).
- **AWS says quotas are best-effort**: "not hard limits… Don't rely on usage plan
  quotas or throttling to control costs" (manual-api-key-tier.md:646-648). The
  frontend uses `used >= limit` because AWS can count a burst past the quota
  (web/portal/src/app/app.tsx:3697-3708).

## 2. The period

- **Calendar month, UTC**, as **Prices' own rule**: 1st 00:00:00 UTC to the next 1st
  (PA/portal/period.rs:1-23, `containing` :44, `resets_at` :85, `start_secs` :91;
  tests for December, leap February, boundaries :113-156).
- Usage plans are `Period.MONTH`, offset 0 (infra/src/lib/stacks/api-gateway-stack.ts:831-862).
- AWS doesn't document its reset instant. Measured on production: it falls between
  00:00 and 00:05 UTC on the 1st (ADR 0010, lore/2-adrs/0010_...md:701-728; history :73-80).
  So AWS's counter and Prices' label agree to within 5 minutes. Not confirmed: the
  exact instant inside that window.
- At the boundary, the instant 00:00:00 on the 1st belongs to the new month: a revoke
  at exactly that second is capped until the following 1st (PA/portal/keys/cap.rs:49-55, test :133-145).

## 3. At the limit

- **Hard stop by the gateway**: `429`, body `{"message":"Limit Exceeded"}` (AWS's
  quota response). Measured on a `DAY` scratch plan (0180 note :207); the
  production `MONTH` one has never been seen (web/portal/src/quickstart/QuickStart.tsx:708-711).
  The rate-limit 429 is `{"message":"Too Many Requests"}` with
  `x-amzn-errortype: TooManyRequestsException` (QuickStart.tsx:690-695).
- **No `Retry-After`, no `X-RateLimit-*` headers**, and no custom gateway response
  for `QUOTA_EXCEEDED`: only `THROTTLED` and `DEFAULT_5XX` are customised, for CORS
  (api-gateway-stack.ts:943-976). The OpenAPI says so on every keyed route
  (PA/assets/handlers.rs:101; docs/prices-api-general-overview.md:536).
- **A disabled/revoked key answers `403 {"message":"Forbidden"}`**, the same as no
  key; disable takes ~25 s to reach the data plane (0180 note :225-237).
- **Usage is per key, and does not carry over to a new key.** That's why the cap
  exists (PA/portal/keys/cap.rs:10-15): a new key is a clean counter, so a new one
  is only issued once the revoke's month has passed. Disabling preserves the counter
  (0180 note :195-212). Moving a key to another plan restarts its counter at zero
  (manual-api-key-tier.md:227-230). A hand rotation by the operator gives a fresh
  month's allowance (manual-api-key-tier.md:593-596). After a revoke the hub tab shows
  "no usage to show" (hub: src/account/prices/PricesTab.tsx:160-164).

## 4. Plans and tiers

- **Where:** the figures are in `infra/envs/production.json:6-13`, typed in
  infra/src/lib/types.ts:32-40, :82-113, and become five AWS usage plans in CDK
  (api-gateway-stack.ts:831-862), named `pricing-api-<tier>-production`. The backend
  reads the tier from the plan's **name** (PA/portal/keys/gateway.rs:289-321);
  any other plan on the stage is `Custom`.
- **Defaults:** Free 100 000/month, 1 req/s, burst 5; Basic 1M, 3/s; Analyst 5M,
  5/s; Lite 20M, 10/s; Pro 50M, 25/s (manual-api-key-tier.md:34-40).
- **Raising one account:** by hand with the AWS CLI. Delete the plan key on the
  free plan, create it on the target plan; the key's value stays the same
  (manual-api-key-tier.md:100-245). Custom plans are made by hand outside CDK,
  limits adjusted with `update-usage-plan` (:533-539). There's no admin route, and
  the portal's role can't move a key (:18-22). Every move gets a row in a table at
  the end of the runbook (:244-246).
- A replacement key keeps the revoked key's paid plan (`resolve_target_plan`,
  PA/portal/keys/mod.rs:1592; runbook :234-238).

## 5. What the user sees

- **Hub `account` call** (docs/runbooks/hub-contract.md:378-410; PA/portal/hub/account.rs:4-9, :87-92):
  `details: { usage: <the /api/usage body> | null, free_rate_limit_per_second }`.
  The usage body (PA/portal/usage/mod.rs:345-391) has `used`, `remaining`,
  `limit` (the plan's quota), `period_start`, `period_end`, `resets_at`, `as_of`
  and `plan {tier, name, rate_limit_per_second, burst_limit, quota_limit, quota_period}`.
  `used`/`remaining` are null together when AWS has no row yet.
  `usage: null` beside `active` means the read failed. The key's own block has
  `can_issue` and `next_eligible_at` for the cap.
- **Dashboard:** a "Monthly Usage" card with used/remaining/limit, the reset date,
  "Last updated … AWS reports usage with a delay" (web/portal/src/app/app.tsx:3690-3695).
  At `used >= limit` a red strip says "Monthly quota reached. API requests will
  return HTTP 429 until the quota resets on <date>. Contact us for higher limits."
  (app.tsx:3361-3400). The hub reuses the same component (hub: src/prices/dashboard/UsageFigures.tsx:18-66).
- **No warning near the limit** (no 80% state found), **no emails**: Prices keeps
  no email address (ADR 0010 :206-210).

## 6. Monitoring

- **No quota metric, event or alarm.** API Gateway's metrics aren't per key; the
  only view is the dashboard widget "4xx (includes 429 throttles)"
  (infra/src/lib/stacks/observability-stack.ts:2701-2723). The api-handler alarms
  are about errors and the portal's loads (:1311, :1335-1395).
- Logs only: a `warn` when `GetUsage` shows a reset inside the queried range, and
  when `used + remaining` disagrees with the plan's quota (PA/portal/usage/mod.rs:930-943;
  gateway.rs:1128-1133). Hub calls log `jti`, `act`, outcome, `key_id`, and `capped`
  (hub-contract.md:473-481).
- ADR 0010 says the first sign of abuse would be the shared ClickHouse slowing down,
  not a bill: "Watch BE's query latency" (lore/2-adrs/0010_...md:496-501, :673-676).

## 7. Why (ADRs and epic)

- **A monthly quota, not just a rate:** "A per-second limit alone doesn't stop a key
  idling at 1 req/s from generating 2.6M requests/month", and CoinMarketCap shows "the
  monthly cap is what actually bounds cost and abuse" (docs/epics/self-service-onboarding.md:188-191).
  The quota "binds ~26x harder" than the throttle (infra/src/lib/types.ts:90-97).
- **One active key per account** because AWS's quota is per key and "has no principal
  that sums keys". Several keys would mean summing `GetUsage` ourselves (ADR 0010 §2
  :146-155, rationale :431-443; Alternative 7 :598-606).
- **The cap after a revoke:** "so a user can't burn their monthly quota and rotate
  to a fresh key to reset the counter mid-month". Capping how often a key can be
  replaced avoids counting usage across a user's whole key history (epic :106-117).
  "Revoking does not earn a replacement… Otherwise 'revoke' becomes the button people
  press to escape a burnt quota" (epic :291-293; cap.rs:10-15).
- **Gates are thin on purpose** ("two clicks and a five-minute wait"). What makes
  that acceptable is how little a drained key costs ($0.55–0.89 a month), plus a
  lower free quota held in reserve as "the first lever to pull" (ADR 0010 :157-210,
  :466-505, Alternative 6 :572-596).
- **Paid tiers by hand**: no in-app billing; "Anything higher requires actual human
  contact" (epic :192-198, :200-204).

## 8. Bans

**No ban mechanism found.** There is no denylist, flag or SSM setting by Discord id
(searched PA/portal, runbooks, epic, ADR 0010). What an operator can do:

- **Disable the key** (`update-api-key … /enabled false`, manual-api-key-tier.md:540-545).
  To the portal this looks like a revoke. Its `lastUpdatedDate` sets the cap, so the
  user **can get a new key from the next 1st** (PA/portal/keys/mod.rs:1281-1296).
- **Delete the key**: then there's nothing to cap, and the user can issue again at once.
- A user who leaves the Discord keeps their key; membership is checked only at issue
  (ADR 0010 §7 :244-247). Under the hub, membership is the hub's to prove
  (hub-contract.md:422-424), so a ban there (or removal from the Stellar Developers
  server) is the only lasting lever. Not confirmed: whether the hub has one.
- The dashboard's revoked card shows a "Reason: Monthly quota exceeded repeatedly.
  Key was suspended…" line, but it's **verbatim design text**, not backed by any
  automatic suspension (web/portal/src/app/app.tsx:1711-1719; test app.spec.tsx:4564-4567).

## What stellar-x402 can reuse or should do differently

- **Count per owner, not per key.** x402 has its own Postgres registry and is its own
  gateway, so it can (and per 0106 "the usage stays with the account") must count
  settlements keyed by `discord:<id>` + month. Prices' cap is still useful as a
  limit on key churn (decision 24), but x402's quota no longer depends on it. That
  removes the loophole Prices' cap was built for.
- **Reuse `Period` as is:** calendar month UTC, `[1st 00:00, next 1st 00:00)`, the
  boundary second in the new month, one module both the quota and the revoke cap read
  (PA/portal/period.rs). Name the bucket by the month the settlement is **counted**
  in. Decide whether that's the request's arrival or the reservation, and write it down.
- **Count atomically, at reservation:** Prices learned that AWS counts only what it
  lets through and can overshoot (`used >= limit`). x402 should increment in the
  same transaction as the spend-policy reservation (a conditional `UPDATE … WHERE
  used < limit`), so two concurrent settles can't both take the last slot. Count
  failed settlements too (0107 says so); refused ones not.
- **Answer better than Prices can:** a JSON error with its own `code` (e.g.
  `quota_exceeded`), `limit`, `used`, `resets_at`, and `Retry-After` to the reset.
  Prices can't, because the gateway answers for it (no `Retry-After`, no headers). Use
  `429` for parity, or `402`/`403` if x402 clients treat 429 as "retry soon".
  Optional `X-RateLimit-*`-style headers are cheap here.
- **Copy the hub's `details.usage` shape** (`used`, `remaining`, `limit`,
  `period_start`, `period_end`, `resets_at`, `as_of`, `plan{tier,quota_limit,
  quota_period}`) so the hub can reuse `UsageFigures` and its "quota reached" strip.
  x402's numbers are live, so `as_of` is just "now".
- **Plan limits as data, not names:** Prices reads the tier from an AWS plan
  name and moves keys with the CLI. x402 can hold a per-owner override row (limit,
  tier label, who, when, note) and record changes the way Prices' runbook table does.
  It's one `INSERT`/`UPDATE` for the operator, and the grant stays off the portal's role.
- **Add the monitoring Prices lacks:** events for nearing (e.g. 80%) and reaching the
  quota per owner, and the shared free budget nearing its limit (0107's 0027 items).
  Prices has no per-key signal at all.
- **Add a real ban** if wanted: a `blocked` state per owner that `issue` and
  `/settle` both refuse. Prices' disable only lasts until the 1st, and a delete
  lifts the cap at once.
