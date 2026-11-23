---
id: "0106"
title: "Issue API keys from our portal after Discord sign-in"
type: FEATURE
status: completed
owner: akot
milestone: 2
related_adr: ["0007"]
related_tasks: ["0024", "0105", "0107", "0158", "0159"]
tags: [facilitator, portal, security, before-pubnet, priority-high, effort-large, platform]
links:
  - ../../../docs/adr/0007-fee-abuse-containment.md
history:
  - date: "2026-11-03"
    status: backlog
    who: akot
    note: "Spawned from 0024: keys on pubnet come from our portal, as in stellar-prices-api."
  - date: "2026-11-16"
    status: active
    who: akot
    note: "Work starts."
  - date: "2026-11-17"
    status: active
    who: akot
    note: >
      The dashboard model is changing, in progress: one hub at sorobanscan.com/api, one sign-in
      at /api/login and one dashboard in a repo of its own, with a tab per product. See
      "The dashboard model is changing".
  - date: "2026-11-17"
    status: blocked
    who: akot
    note: >
      Paused by akot: the priority is one repo, sorobanscan-api-portal, with the Prices portal
      moved in and working on the shared sign-in (its design:
      docs/superpowers/specs/2026-11-17-shared-sign-in-design.md there). This task's own sign-in
      is not deployed; x402's move to the shared sign-in gets a design and plan of its own when
      work here resumes.
  - date: "2026-11-18"
    status: active
    who: akot
    note: >
      Resumed: the hub issues Prices' keys since 2026-11-18, and x402's keys move to the same
      contract. Design approved by akot the same day: "The hub's contract", decisions 23-33.
  - date: "2026-11-23"
    status: completed
    who: akot
    note: >
      PRs #194, #213, #222 and #223 merged (#212 closed: the page moved into the hub). The
      portal's backend is in production since 2026-11-20 and the hub's x402 tab is public at
      sorobanscan.com/api/ since 2026-11-23, where akot got a key, was refused with the reason on
      accounts that fail the gates, and revoked the key, all four criteria on production. 37
      decisions. Left: the late fixes' deploy and the uptime alarms (0159), removing
      `apps/portal-web` (0158), the ban question of decision 35 (0107).
---

# Issue API keys from our portal after Discord sign-in

## Summary

A seller gets the pubnet API key (0105) from our own portal, after signing in with Discord, the
way stellar-prices-api issues its keys (decided by akot, 2026-11-03). That project's
`docs/epics/self-service-onboarding.md` and its ADR 0010 record the flow and why each gate is
there; most of its portal (`web/portal/`) can be reused. A key must cost something, or the Sybil
attack from 0024 moves from addresses to keys: here it costs a Discord account in the Stellar
Developers server.

## The hub's contract (design approved by akot, 2026-11-18)

Resumed on 2026-11-18. x402's keys are issued from the hub, as Prices' are since that day.

- **Intent.** A member signed in at `https://sorobanscan.com/api/login` sees an x402 tab: the
  key's state, "Get API Key" without one, Show and Copy, Regenerate. The hub's backend (the BFF)
  calls `https://x402-portal.sorobanscan.com/api/hub/v1` server to server; no browser does.
- **Approach.** Prices' contract, as deployed on 2026-11-18, carried over one for one
  (stellar-prices-api `docs/runbooks/hub-contract.md`; the hub's spec, "The dashboard contract"
  and decisions 12-16). Considered and dropped: the contract beside this task's own sign-in
  (two ways in, two sets of secrets, for a sign-in nobody uses), and a contract of x402's own
  shape (a second client and a second tab's logic in the hub for no gain).
- **`apps/portal`** answers `GET /api/hub/v1/account` and `POST /api/hub/v1/key/{reveal,revoke,issue}`
  on the registry and `SealedKeyStore`. Its Discord sign-in, session, `/api/auth/*`, `/api/me`,
  CORS and the `DISCORD_*` and `SESSION_SECRET` settings go. The token is the hub's
  `v1.<payload>.<mac>` (HMAC-SHA256, compared in constant time) with `aud` `x402`, the context
  `sorobanscan-hub/x402-token/v1` and an `act` per route; `401 invalid_token`,
  `403 action_not_allowed` as in Prices. Membership and screening are the hub's to prove before
  it signs an `issue` token; the account's age is checked here, from the snowflake.
  `account`'s `details` holds no use (0107).
- **`apps/portal-web`** loses `/login` and `/dashboard`; every "Get API Key" goes to
  `https://sorobanscan.com/api/login?from=x402`.
- **The hub** (`sorobanscan-api-portal`, a pull request of its own): the token's signer and the
  product's client take the product's name, a secret `sorobanscan-hub/production/x402-token`,
  `X402_HUB_API`, `x402` in `HUB_PRODUCTS` and `VITE_PRODUCTS` by opt-in, and a tab
  `src/account/x402/`. Production's hub stays on Prices alone until x402 opens; the contract is
  tried from a local hub on production's backend, as Prices' was.
- **Not here:** the account's use and quota (0107); a pubnet registry (0126, decision 19); the
  hub checking membership in the background (a pull request of its own there).
- **Left to the builder:** the modules' names, the log lines' wording, the tab's components.

Decisions 2, 4, 7, 10, 11, 12 and 14 below are replaced by 23-33; decision 22's reason changes
(decision 33).

## The dashboard model changed (2026-11-17)

**Paused, 2026-11-17 (akot); resumed 2026-11-18.** First one repo with the Prices portal moved in and working on
the shared sign-in; this task resumes after. The backend's first deploy (`x402-portal@`, the
`production-portal` environment, `soroban-infrastructure` #11) is held, since its sign-in,
session and `/login`/`/dashboard` pages are to be replaced. The shared sign-in's design, in
`rumblefishdev/sorobanscan-api-portal` (`docs/superpowers/specs/2026-11-17-shared-sign-in-design.md`):
a BFF in AWS under `sorobanscan.com/api/hub/*` signs in with Discord (members who cleared
screening only), and each product's backend trusts a 60-second HMAC-SHA256 token from it (the spec's decisions 12 and 15) through a
four-call contract (`account`, `reveal`, `revoke`, `issue`). The registry, `SealedKeyStore` and
the gates' code here are expected to carry over.

Decided by akot, 2026-11-17: the portals of Prices API and x402 stop being separate.
`https://sorobanscan.com/api` becomes a hub after akot's design ("APIs hub landing page"), with
a link to each product's landing page; one sign-in at `/api/login` (today a `301` to
`/api/prices-api/login`) and one dashboard, with a Prices API tab, an x402 tab and later ones.
The hub, sign-in and dashboard live in a repo of their own, `rumblefishdev/sorobanscan-api-portal`.
In three steps, each with a design of its own:

1. The hub, as the first page of the new repo's app (design and plan approved by akot,
   2026-11-17; in progress). The designed hub stays behind Basic Auth until x402 opens, and the
   explorer's hub stays public at `/api/` until then.
2. One sign-in and the dashboard, with the Prices API tab.
3. The x402 tab: this task's keys move into the shared dashboard.

What this puts in question here, to settle in steps 2 and 3, not yet decided: decision 2 (a
Discord application of our own) and decision 4 (the page's own views); `/login` and
`/dashboard` in `apps/portal-web`, and the sign-in and session in `apps/portal`. Both products
already name an account by its Discord ID, so a shared sign-in needs no account migration.

## Implementation

- Discord OAuth with `identify` and `guilds.members.read`: the account must be a member of
  Stellar Developers (`897514728459468821`) with its Membership Screening cleared (not `pending`),
  and at least 5 minutes old (from its snowflake). Checked when a key is issued.
- One active key per Discord account. Revoking takes effect at once, and the usage stays with
  the account, not the key. A new key after a revoke waits for the next calendar month (decision
  24, which replaced "prices-api's once-a-month rotation limit isn't needed").
- A dashboard: the key's state and the account's use of its free quota (0107).
- A privacy policy for the Discord IDs we keep, as prices-api has.
- From 0105: the portal writes the registry through `ApiKeyStore` (`issue`, `revoke`), with the
  owner `discord:<snowflake>`. `issue` refuses an owner that has an active key, and a revocation
  holds from the next request. The registry keeps only a key's SHA-256, so a key can be shown
  once: that settles the third decision below unless the portal keeps keys itself.

## Decisions to make here

- ~~Where the portal and its backend run.~~ Made by akot on 2026-11-16: "Design Decisions", 1.
- ~~One Discord application with prices-api or our own.~~ Decision 2.
- ~~The key shown once or viewable again.~~ Decision 3.
- ~~How much of prices-api's portal to copy.~~ Decision 4.

All made by akot on 2026-11-16.

## Acceptance Criteria

- [x] Given a Discord account that meets the gates, when it presses "Get API Key" in
      the hub's x402 tab, then it gets one pubnet key
- [x] Given an account outside Stellar Developers, still pending screening, or younger than 5
      minutes, when it asks for a key, then it is refused and told why
- [x] Given an account with a key, when it revokes it (the tab's Regenerate), then the old key
      stops working, a new one can be had from the next calendar month (UTC, decision 24)
      and the account's quota use carries over
- [x] Given the portal, when it is live, then its privacy policy says which Discord data we keep

Checked by akot on production, 2026-11-23, in the hub at `https://sorobanscan.com/api/`; what each
tick rests on is in "Implementation Notes", "On production".

## Implementation Notes

- **Page skeleton.** `apps/portal-web` (React 19, Vite 8): a hello-world page built for the
  prefix `/api/x402-facilitator/` (`src/base-path.ts`). `test/base-path.test.ts` builds the page
  and checks every file it asks for is under the prefix. Adding Vite 8.3.8 moved the workspace's
  Vitest from Vite 8.3.1 to 8.3.8 in the lockfile; `pnpm test`, 2026-11-16: 21 of 21 tasks.
- **The designed page, static.** akot's design (one page: hero with the Bazaar search, how it
  works, the comparison, use cases, quickstart, endpoints, the key card, FAQ) as React sections
  in `apps/portal-web/src/sections`, its text as the design has it. Nothing is wired: the search
  box holds its words, the key card shows the design's placeholders. Fonts come from
  `@fontsource-variable/*` in the bundle, not Google Fonts (akot, 2026-11-16), and
  `test/base-path.test.ts` checks no stylesheet names another host. Seen in a browser at 1568 px,
  2026-11-16.
- *Superseded on 2026-11-18: the page has no `/login`; "Get API Key" goes to the hub (decision 25).*
  **The sign-in page.** Every "Get API Key" opens `/login` (react-router, `basename` from the
  prefix): one card after the Prices API portal's `/login`, in this page's colours and type. It
  says who may have a key above the button (Stellar Developers membership, an account that is not
  brand new), and the button is shut with "Sign-in is not open yet." until the backend exists.
  Its "What you get" list names no quota: that is 0107's. An address the page doesn't know shows
  the landing page.
- **The registry is a package.** `packages/api-keys` holds what the facilitator and the portal's
  backend both need: `ApiKeyStore`, `PostgresApiKeyStore`, a key's form and hash, the owner's
  rules and the store's contract tests (`@stellar-x402/api-keys/testing`). Moved from
  `apps/facilitator` with no change in behaviour; the migration, the `Authorization` header and
  the pubnet rule stay there. `pnpm test`, 2026-11-16: 23 of 23 tasks, the facilitator 1119 tests
  (3 skipped) and the package 3: two moved with the helpers, one new for `isApiKey`. The
  facilitator's image is built by the deploy workflow only, so the image with the new package is
  not built yet.
- *Superseded on 2026-11-18: the routes went (decision 25); `SealedKeyStore` and `0014` stay.*
  **The backend.** `apps/portal` (Express): `/api/auth/login`, `/api/auth/callback`, `/api/me`,
  `/api/key/reveal`, `/api/key/revoke`, `/api/auth/logout`, `/health`; its README has the flow,
  what is kept and the settings. `SealedKeyStore` in `packages/api-keys` writes the registry and
  a key's sealed copy in one transaction; the facilitator's migration `0014_api_key_copies` makes
  the table. Not wired to the page yet, no image or deploy files, and the threat model, ADR 0012
  and the facilitator README don't know the copy yet.
- *Superseded on 2026-11-18: the portal's 98 tests and nine removal checks were the sign-in's.*
  **Backend tests**, 2026-11-16: `apps/portal` 98, on Discord and the registry in memory;
  `packages/api-keys` 27, the in-memory store on the same contracts as PostgreSQL's; the
  facilitator runs the sealed store's contract and the table's checks on PostgreSQL. Each of nine
  checks was removed in turn (the nonce, the action, the state, the cleared cookie, the origin,
  CORS, the session, the signing context, issue-only-on-`issue`) and a test failed each time.
- *Superseded on 2026-11-18: it ran the sign-in's routes, which are gone (decision 25).*
  **Run by hand**, 2026-11-16, on a scratch schema of the local database: refused to start
  without the tables, naming them; after the facilitator's migrations `/health` answered,
  `/api/auth/login?action=issue` redirected to `discord.com/oauth2/authorize` with the two
  scopes, the callback URL, a state and an S256 challenge, `/api/me` answered 401, a `POST`
  without an origin 403, and SIGTERM stopped it.
- *Superseded on 2026-11-18: this backend no longer talks to Discord (decision 25).*
  **Through the real Discord**, 2026-11-16, by akot on his development application and the local
  database: `/api/auth/login?action=issue` went to Discord's consent screen and back, and the
  backend logged `key_issued` and `signed_in` for the account. One account that passes the gates;
  no refusal was tried against the real Discord.
- *Superseded on 2026-11-18: no `/login` or `/dashboard`; the keys are in the hub's tab.*
  **The page on the backend.** `/login`'s button goes to `/api/auth/login?action=issue`, and
  `/dashboard` shows the account its key: the state, the key on "Show key" or "Copy key", revoke
  after a second click, a new key through another sign-in, each `?issue=` and `?signin=` outcome
  in words, read once and taken off the address. The backend's origin is a build setting,
  `VITE_PORTAL_API_ORIGIN`; a build without it keeps sign-in shut. The dashboard's two tiles say
  what is so (pubnet needs the key, testnet none), not the design's use and quota, which 0107
  brings. `apps/portal-web`: 32 tests. Seen in a browser, 2026-11-16: `/dashboard` on the dev
  server read the account and its active key from the local backend, across the two origins.
- **The backend's image and deploy.** `apps/portal/Dockerfile`; on the server a Compose project
  of its own (`deploy/production/portal.compose.yaml`), the units `x402-portal@` and
  `x402-portal-deploy@`, `deploy-portal.sh` and `x402-portal-deploy`; the workflow
  `deploy-portal-production.yml`; the playbook's entries, the two log files in the CloudWatch
  agent's config, and the runbook's section "The portal's backend" with the admin steps. The
  facilitator's workflow now ignores a push that changes only `apps/portal` or `apps/portal-web`.
  Nothing else the facilitator's units read changed: not `compose.yaml`, `x402-compose`,
  `x402-deploy`, `deploy.sh` or its units.
- *In part superseded on 2026-11-18: the bundle's run below was the sign-in version's.*
  **Checked, 2026-11-16**, without Docker or the server: `deploy/test/portal.test.ts` runs the
  real `x402-portal-deploy` and `deploy-portal.sh` with fakes for `docker`, `systemctl` and
  `sudo` (a healthy image, one that doesn't answer, a unit that doesn't start, a first deploy
  that fails, a failed pull, a deploy cut after the digest moved, anything but a digest
  refused), and five of the script's behaviours were removed in turn with a test failing each
  time. The production bundle (`pnpm deploy --prod`, as the Dockerfile makes it) started with its
  four secrets from files and the role `x402_portal`'s grants on a scratch database: `/health`
  200, the sign-in redirect with `x402-portal.sorobanscan.com`'s callback, issue, show, revoke
  and a new key through the store, every other table and every other write refused, exit 0 on
  SIGTERM. `systemd-analyze verify` on both units.
- *In part superseded on 2026-11-18: akot's run was of the sign-in version; not run since.*
  **`deploy/scripts/check-production-portal.sh`**, run by hand, not by CI (akot, 2026-11-16):
  it builds both images, migrates production's Postgres
  with the facilitator's, makes the role from the runbook's own `GRANT` lines and starts the
  backend from `portal.compose.yaml` with its secrets owned as the unit says; then the deploy's
  probe, Docker's healthcheck, the container's limits, the sign-in redirect, the registry through
  the role from inside the container, and exit 0 on a stop. Run by akot on 2026-11-16, on Docker
  from a snap: all of it passed, with `no-new-privileges` taken off every service, since that
  Docker can't start a container with it ("operation not permitted"); the script does that only
  there, and says so. So both images build, the facilitator's with the new package too, and
  `no-new-privileges` on the portal's container is the one limit not yet seen working.
- **Not checked:** `no-new-privileges` on the backend's container (above); the playbook never
  ran (parsed, and its `authorized_keys` template rendered with and without the portal's key);
  the deploy workflow never ran; nothing has been on the server.
- **Toward the first deploy**, 2026-11-17: the hostname and its record in
  `soroban-infrastructure` #11 (applied 2026-11-18 by stkrolikiewicz;
  `x402-portal.sorobanscan.com` answers 502 until the first deploy); the GitHub environment `production-portal`, with
  `production`'s reviewers, "Prevent self-review", no admin bypass and only `deploy/production`,
  and its secrets `DEPLOY_SSH_KEY` and `DEPLOY_HOST` (the server's address, from SSM
  `/x402/production/server-ip`); the key's public half in
  `deploy/ansible/files/deploy-portal-production.pub`. `production` has no `DEPLOY_PORT`, so
  neither does this one.
- **The design says things that aren't so yet**, left as designed while the page is behind Basic
  Auth, to settle before it opens: "Live on Stellar Mainnet" (pubnet is refused until 0126, 0107
  and 0090); "One key works on mainnet and testnet" (testnet reads no key, 0105); the quickstart's
  `https://api.sorobanscan.com/x402` and its key on `/supported` (the facilitator is at
  `x402-facilitator.sorobanscan.com`, `/supported` is open); `/discovery/search` and `/mcp` (the
  facilitator has `/discovery/resources` only); "Rate limits per key on … /discovery" (by IP);
  `[PRICE]`, `[USED] / [QUOTA]` and `[PRICING…]` (0107).
- **The hub's contract, 2026-11-18**, on the branch `lore-0106-hub-contract` from `develop`. The
  registry package and the sealed store came from this task's first branch by cherry-pick,
  unchanged; the migration kept its number, `0014_api_key_copies`.
- **The backend answers the hub.** `apps/portal`: `GET /api/hub/v1/account`,
  `POST /api/hub/v1/key/{reveal,revoke,issue}` and `/health`, on `SealedKeyStore`. The token
  (`src/hub-token.ts`), the month's cap (`src/cap.ts`), the account's age (`src/eligibility.ts`)
  and the seal (`src/seal.ts`) are modules of their own; the limits are in memory. No sign-in,
  session, cookie or CORS. Its settings are `HUB_TOKEN_SECRET`, `KEY_ENCRYPTION_KEY` and
  `DATABASE_URL` (each also as `_FILE`), `MIN_ACCOUNT_AGE_MINUTES`, `PORT`, `CLIENT_IP` and
  `LOG_LEVEL`; its README has the contract, the errors, the limits and the log events.
- **Its tests**, 2026-11-18: `apps/portal` 96, on the store in memory, and `packages/api-keys` 27.
  The token vector pinned there is the one the hub pins for x402 (`bff/test/token.test.ts` on its
  `feat/x402-tab`), and Prices' token for the same claims is refused. Six checks were removed in
  turn and a test failed each time: the `act` check, the `previous` key, the cap in `issue`, the
  limiter for tokens that don't verify, the one by account, and the `has_key` answer to an issue
  that lost the race to another.
- **Its start, checked without a database**, on the built `dist`: without `HUB_TOKEN_SECRET` it
  logs `startup_failed` naming the setting and exits 1; with every setting and a database that
  doesn't answer it logs `startup_failed` with the connection's error and exits 1, and its output
  holds neither the database's password, the encryption key nor the hub's secret.
- **`apps/portal/test/live/hand-run.sh`** walks the four calls on a scratch schema with tokens it
  signs, and drops the schema at the end. Run on 2026-11-18 on the local database, once it was
  up: the facilitator's migrations into the schema, `/health` 200, no bearer and
  `Bearer v1.probe.probe` both `401 invalid_token`, then `account` (`none`), `issue` (`issued`),
  `account` (`active`, showable), `reveal` (a key), `revoke`, `issue` again (`capped`), exit 0 on
  SIGTERM, and no secret, password or key in the backend's log. No schema or file left behind.
- **`pnpm test`** at the root, 2026-11-18, on the local database: 22 of 22 tasks; the
  facilitator 1177 tests (3 skipped), the sealed store's contract on PostgreSQL and migration
  `0014`'s checks among them.
- **The image and deploy**, from the first branch: the Discord and session secrets gave way to
  `portal-hub-token-secret`, and `check-production-portal.sh` probes the contract (a call with no
  bearer, `401 invalid_token`) where it followed the sign-in's redirect. `@stellar-x402/deploy`:
  144 tests, 2026-11-18.
- **The page sends "Get API Key" to the hub.** `apps/portal-web` has no `/login`, `/dashboard` or
  router; each "Get API Key" goes to `https://sorobanscan.com/api/login?from=x402`. 15 tests, the
  build clean, 2026-11-18; not seen in a browser.
- **The docs**: the runbook's "The portal's backend" for the hub's contract (the three
  credentials, the secret's copy on the server and its change in four steps, the probes, the log
  events, Cloudflare), and the sealed copy in the threat model, ADR 0012 and the facilitator's
  README, with the hub's secret as a trust boundary in the threat model.
- **Not checked, 2026-11-18:**
  - Docker was not usable, so `check-production-portal.sh` did not run on this branch and
    neither image was built.
  - Until late that day there was no PostgreSQL either: the commits before the docs were made
    without the facilitator's PostgreSQL tests, which ran only at the end (above).
  - None of the runbook's AWS, SSH, server or `gh` commands has run anywhere: the secret's
    creation and copy, the four steps of its change, the rollback, the SQL for a leaked
    encryption key, the `key_id` query. Their `jq` filters and shell were tried locally, with
    stand-ins for `aws` and `ssh`.
  - The role `x402_portal` and its grants have not been made on any server.
  - That Browser Integrity Check answers a request with no `User-Agent` with 1010 rests on the
    facilitator's host's record (0026), not on this host.
  - Still to do: the Browser Integrity Check rule for `x402-portal.sorobanscan.com`, and the stub
    of `deploy-portal-production.yml` on `main`.
  - Nothing has been deployed, and the hub's tab has not called this backend.
- **Before the first deploy**, from the final review, 2026-11-18, beyond "Not checked":
  - The order of approvals. The promotion that brings the portal starts both deploys; approve the
    portal's only once the facilitator's (migration `0014`) has ended, then the playbook, then the
    role. Nothing enforces it: approved early, the backend logs `startup_failed`, the first deploy
    fails and `portal.digest` is removed.
  - The GHCR package `x402-portal` exists only after the image job's first push, and must be made
    public before the approval, or the server's `docker pull` fails.
  - Never exercised on the server: a login as a role other than `postgres` from the `db`
    network, the portal's addresses in the two networks, `no-new-privileges` on its container.
  - The hub's side: the BFF's IAM grant for the secret, and `x402` in `HUB_PRODUCTS`.
  - Decision 21 stood: no alarm, watchdog or uptime probe for the backend (the probes came on
    2026-11-20, decision 21).
  - `KEY_ENCRYPTION_KEY` has no backup.
- **The final review**, 2026-11-18, on the whole branch, ran: `apps/portal` 96 tests,
  `packages/api-keys` 27, `@stellar-x402/deploy` 144, `apps/portal-web` 15, the root typecheck 23
  of 23 tasks, and the root test 22 of 22 with the facilitator at 1177 passed and 3 skipped. Its
  fixes: `/health` shares one database probe's answer for 2 s and logs `not_ready` once in that
  time at most (`HEALTH_WINDOW_MS`; `apps/portal` 99 tests with its three); the runbook's secret
  steps stop with a `stopped:` line on every failed `ssh`, step 1 refuses while a change is under
  way, step 2 refuses between steps 3 and 4 and waits for the backend's `401` inside its subshell,
  and step 3 compares with the copy the running backend started on and tells "already run" from
  "run step 2"; `create-secret` checks with `KEYS_OK`; the role step stops non-zero on failure.
  Those blocks ran against stand-ins for `aws`, `ssh`, `curl` and `sudo`, with no key in any
  argv or output. After the fixes, the root typecheck 23 of 23 and the root test 22 of 22 again,
  the facilitator 1177 passed and 3 skipped, `apps/portal` 99.
- **The review of #194**, 2026-11-19 (decision 36): a stranger's IPv6 address counts by its /56,
  and a store that failed answers `502 key_unavailable`. Both new tests failed first (`401` for
  `429`, `503` for `502`). `apps/portal` 100 tests and its typecheck, eslint and prettier; the
  production bundle (`pnpm deploy --prod`, as the Dockerfile makes it) imports
  `express-rate-limit`. The facilitator's tests were not run again: nothing of it changed.
- **The uptime probes**, 2026-11-20, on the branch `lore-0106-portal-uptime` (decision 21):
  `infra/lambdas/uptime-probe` takes its target from `HEALTH_URL`, `METRIC` and `EXPECT` and
  refuses a bad one; the Uptime stack makes one function, log group and schedule per target, the
  facilitator's under the ids it was deployed with (its synth compared before and after: only the
  schedule's description and the function's two new variables change). `portal_ready` and
  `hub_ready` in the catalog, the two alarms and groups (both off), the 0027 alarm list and
  G-metrics, `docs/monitoring.md` (the probes, two sections, the off alarms, the metrics), the
  runbook's "Monitoring" under the portal's backend, `infra/README.md`. Tests: `infra` 389 (355
  before), `packages/metrics-catalog` 32; typecheck, eslint and prettier clean. With the probe's
  headers, from a workstation: the portal's `/health` `{"ready":true}` 200, the hub's
  `/api/hub/me` a `302` to `/api/` (the hub's backend isn't routed yet). Not deployed; never run
  from AWS.
- **On production**, 2026-11-23. The backend runs at `x402-portal.sorobanscan.com` since
  2026-11-20 (the fifth deploy, #208; the runbook's server steps and the first deploy that day),
  and the hub is public at `sorobanscan.com/api/` since 2026-11-23, its x402 tab on. akot, in a
  browser:
  - Criterion 1: the tab showed the account's key, issued through the tab against this backend
    on 2026-11-20; Copy worked. The key is in testnet's registry until 0126 (decision 19).
  - Criterion 2: an account outside the server read "Stellar Discord membership required … Join
    the server and try again"; one that had not accepted the rules, "Stellar Discord accept rules
    required … accept the server's rules, then sign in again"; a refusal when asking for the key
    read "You need to be a member of the Stellar Developers Discord to get an API key". akot
    reports every path checked. The age gate's own text ("Your Discord account is too new …") was
    not quoted in the session: `apps/portal`'s tests are what is on record for it.
  - Criterion 3: Regenerate answered "Your key was revoked on 23 November 2026. A new key can be
    issued from 1 December 2026." No request reads a pubnet key before 0126, so "stops working"
    is the registry's `revoked` state and 0105's tests. No quota exists before 0107; the use will
    stay with the account because the registry's owner, not the key, is what 0107 counts by.
  - Criterion 4: `https://sorobanscan.com/api/privacy-policy` carries "x402 Facilitator API
    keys", dated 20 November 2026: the registry's row with the Discord account ID, the sealed
    copy, what the hub sends, what is logged, Hetzner, Cloudflare and CloudWatch.
- **The last pull requests**, 2026-11-23: #213 (the OpenAPI document, brought up to 0086 and
  0155 first), #223 (decisions 34 and 37: the revoke's copy and the log rotation; the root test on
  PostgreSQL 22 of 22 tasks, the race test failing with the fix removed) and #222 (decision 21's
  probes). #212 was closed unmerged: the landing page moved into the hub's bundle
  (`sorobanscan-api-portal` #11, `soroban-block-explorer` #760), which carries its changes, so
  `apps/portal-web` is served nowhere (0158).
- **Not deployed when the task closed** (0159): the portal's image with #223's fix, the playbook
  with the new rotation, and the Uptime and Alarms stacks with #222's probes, whose two alarm
  groups are off. AWS Chatbot answered Slack `account_inactive` on 2026-11-23, so no alarm
  reaches Slack until an admin authorizes the AWS app again.

## Future Work

- Deploy #223 and #222 and turn the two uptime alarm groups on: 0159.
- Remove `apps/portal-web` once the hub serves the landing page: 0158.
- Decision 35, whether an operator's revoke should ban an owner: 0107, before 0126 opens pubnet.

## Design Decisions

### From Plan

1. **The page is served beside prices-api's, the backend runs in a container of its own on the
   Hetzner server.** Decided by akot, 2026-11-16.
   - The page is a static bundle at `https://sorobanscan.com/api/x402-facilitator/`, in the block
     explorer's bucket and CloudFront distribution, where prices-api's portal is
     `/api/prices-api/`. It is published with `aws s3 sync`, so a change to the page never
     restarts the facilitator.
   - The backend (Discord sign-in, issue and revoke, the account's use) is a `portal` service in
     the facilitator's Compose project, reached through the same Cloudflare Tunnel at a hostname
     of its own in `sorobanscan.com`. The registry is in PostgreSQL on the `internal` Docker
     network (ADR 0011), which a Lambda can't reach unless the database is published. The page
     and the backend are two origins of one site, so the session cookie is first-party and the
     backend allows one origin in CORS, as prices-api's does.
   - Not in the facilitator's process: a change to the portal would be a facilitator deploy with
     its drain, and Discord's secret and the session code would sit in the process that settles.
   - Needed outside this repo, in the explorer's distribution (`soroban-block-explorer`,
     `infra/`, read at its master of 2026-11-13): behaviours for `/api/x402-facilitator` and
     `/api/x402-facilitator/*` beside prices-api's, serving the bundle's `index.html` from the
     same bucket. Its `/api/*` behaviour, which today answers every other path with a 301 to
     `/api/prices-api/…`, keeps that for the old portal's own routes (`/api/docs`,
     `/api/dashboard` and the like) and sends the rest to the hub at `/api/` (akot, 2026-11-16).
     A tile for x402 on the hub is a PR of its own there. In `soroban-infrastructure`
     (`cloudflare/x402.tf`): the backend's hostname on the tunnel.
   - The backend's hostname is `x402-portal.sorobanscan.com` (akot, 2026-11-16).
2. **A Discord application of our own.** Decided by akot, 2026-11-16, who registers it. Not
   shared with prices-api: a sign-in to one product is not a sign-in to the other.
3. **The key can be viewed again, as in prices-api.** Decided by akot, 2026-11-16. The registry
   keeps only a key's SHA-256 (0105), so the portal has to keep the key itself, which 0105's
   criterion "only its hash is kept" doesn't cover. It is encrypted with a key held in the
   portal's credentials, in a table only the portal's role reads, and the row is deleted when
   the key is revoked (agreed the same day). The threat model and the facilitator README say
   "only the hash" and need the portal's copy added.
4. **The page has views of its own.** Decided by akot, 2026-11-16: new designs, not a copy of
   prices-api's portal. What is taken from prices-api is the flow and its gates (its ADR 0010).
5. **The backend has an image of its own.** Decided by akot, 2026-11-16. From the facilitator's
   image, as a second entry point like `migrate`, a change to the backend would restart the
   facilitator with its drain, and neither could be rolled back without the other: the server
   keeps one `digest` per environment and the deploy checks the facilitator's health only.
   prices-api ships its portal inside its API's Lambda, where a new version replaces the old one
   with no pause. It costs a second Dockerfile and CI build, a second deploy path on the server
   (forced-command key, script, unit, `digest` files) and `ApiKeyStore` with its PostgreSQL
   adapter moved to a package both programs use. The migrations stay in the facilitator's
   image, the portal's tables too, so a change to the portal's schema is still a facilitator
   deploy.
6. **First a hello-world page at the final address, behind HTTP Basic Auth.** Decided by akot,
   2026-11-16: `https://sorobanscan.com/api/x402-facilitator/` answers before any portal code is
   written, and the whole page stays behind Basic Auth while it is built and tested. The
   explorer's distribution already has the gate (`basic-auth.ts`: a CloudFront KeyValueStore
   holds `base64(user:password)`, put there with the AWS CLI, never in git), so the credentials
   are not in this repo either. The gate covers the page only; the backend's hostname has none
   (decision 22).

### Emerged

7. **A key is issued only in a callback that was started to issue one.** `action=issue` and
   `action=signin` are both signed into the two halves of a sign-in, as in prices-api. The gates
   are read with that round trip's token, so no key is issued on an older answer, and signing in
   alone never brings back a key its owner revoked. The first criterion's "when it signs in" is
   the sign-in the page's "Get API Key" starts, with `action=issue`.
8. **The copy is a table of its own, `api_key_copies`**: a key's hash, which references the
   registry, and the sealed bytes. `SealedKeyStore` (in `packages/api-keys`, beside the registry)
   issues and revokes in one transaction through `PostgresApiKeyStore`'s own statements. The
   migration is the facilitator's `0014`, as decision 5 has it. A key the operator's script
   issued has no copy and shows as "active, can't be shown".
9. **The copy is bound to its row.** AES-256-GCM with the owner and the hash as associated data,
   a version byte first, so a copy moved to another row doesn't open and the key can be rotated
   later. `KEY_ENCRYPTION_KEY` is a setting of its own and must differ from `SESSION_SECRET`.
10. **The sign-in is prices-api's**: a signed `state`, a signed cookie with the same nonce and
    the PKCE verifier, ten minutes, the cookie deleted first; exactly the two scopes accepted;
    a member answer without `pending`, a bare 404 and every failure are "unknown", never "not a
    member". The session is a signed cookie for 24 hours, no table.
11. **A `POST` must name the page as its `Origin`**, beside CORS for the page alone. The page
    and the backend are two hosts of one site, so `SameSite` doesn't keep another
    `sorobanscan.com` host's page from sending the session.
12. **Rate limits are in memory, per address**: 30 a minute to the sign-in routes, 120 to the
    rest. A callback with a genuine state and a made-up code costs Discord a request, so the
    sign-in routes are the tighter ones.
13. **The backend runs no migration** and refuses to start without its two tables.
14. **Nothing caps revoke-then-issue.** prices-api allows one new key per quota period; here an
    account can cycle keys, each a round trip through Discord and a row in `api_keys`. Left
    open: to decide with akot.
15. **Logs name an account by `discord:<id>`**, on sign-in and every key event. For the privacy
    policy, with the registry's owner column. Since the deploy files: shipped to CloudWatch with
    the other units' output (`portal` in the app log group).
16. **A Compose project of its own, not a service in the facilitator's** as decision 1 has it.
    Every unit of that project reads the whole `compose.yaml`, and a service whose image is a
    required variable would have to be set in each of them: a change to the files the
    facilitator, the databases and the tunnel start from, on a server where it can't be tried
    first. `portal.compose.yaml` joins the project's two networks as external ones, so the
    tunnel still reaches `portal:4022`, and none of the facilitator's files changed.
17. **A GitHub environment of its own, `production-portal`,** with the key decision 5 names. In
    the facilitator's environment the two workflows' deployments would share one list, where a
    rollback reads its digest, and one key could start either deploy.
18. **A database role of its own, `x402_portal`:** read and insert in `api_keys`, update of
    `state` and `revoked_at` only, read, insert and delete in `api_key_copies`. Made by an admin
    (runbook), not by a migration. The facilitator connects as the database's owner, so decision
    3's "a table only the portal's role reads" holds through the encryption, not through grants.
19. **The registry is testnet's database until pubnet has one (0126).** It is the only database
    on the server. Keys issued before then are for testing the portal: no request reads them.
20. **The unit is skipped until its first deploy** (`ConditionPathExists` on `portal.digest`), so
    the playbook can enable it before its credentials exist, and a first deploy that fails
    removes the file again.
21. **Uptime probes for the backend and for the hub's, here; the rest later.** Decided by akot on
    2026-11-20 (it was "no watchdog, uptime probe or alarm yet, here or a follow-up"). The
    facilitator's probe (0027), parameterised by its URL, its metric and the JSON fields a ready
    answer holds, runs as two more functions in the Uptime stack: `portal_ready` from
    `https://x402-portal.sorobanscan.com/health` (`"ready": true`), alarm `portal-uptime` in the
    group `portalUptime`; and `hub_ready` from `https://sorobanscan.com/api/hub/me` through the
    explorer's CloudFront (a 200 with `"authenticated": false`: that distribution answers a path
    it doesn't route with a redirect, or with its HTML as a 200 or a 403, so a status proves
    nothing), alarm `hub-uptime` in `hubUptime`. Both alarms take `uptime`'s 7 minutes and count a
    missing point as down. Both groups are off at first (0027 decision 26): `portalUptime` goes on
    once its probe has published; `hubUptime` once the hub's backend is in the explorer's
    distribution (the hub's runbook, step 4) and its probe reads 1. The hub's own `Throttles` and
    `Url5xxCount` alarms are being added in the hub's repo, publishing to this repo's
    `x402-production-alarms` topic. Later: a watchdog for the backend, metric filters with alarms
    on its log lines, and a `ConcurrentExecutions` alarm for the hub's Lambda.
22. **No gate on the backend's hostname while it is tested.** Decided by akot, 2026-11-17. The
    keys it issues are read by no request until 0126 (decision 19), the Discord gates still
    apply, and Cloudflare Access in front of it would stop the page's CORS requests.

### The hub's contract (2026-11-18)

23 to 25 are akot's. 26 to 33 were proposed by Claude where Prices' contract settles nothing, and
approved by akot the same day with the design.

23. **The token's secret is a file on the server.** An admin copies the value of
    `sorobanscan-hub/production/x402-token` in AWS Secrets Manager (JSON `{"current",
    "previous"?}`) into a file the container reads as a Compose secret, like the backend's other
    secrets. The container holds no AWS credentials. The value is changed in Prices' four steps
    (its `docs/runbooks/hub-contract.md`), with a restart of `x402-portal@` where Prices recycles
    its Lambda.
24. **A new key after a revoke waits for the next calendar month (UTC), as in Prices.** Replaces
    decision 14. `account` says `can_issue` and, while the cap holds, `next_eligible_at`; `issue`
    in the same month answers `capped`. The rule and its edge cases are Prices' (`keys::issue_for`,
    its "cap instant", `tests/portal_hub.rs`: a revoke in an earlier month is `revoked` with
    `can_issue: true`), read here from `revoked_at` in `api_keys`. Known and accepted: pubnet's
    `/verify` and `/settle` need the key, so a seller who revokes a leaked key early in a month
    settles nothing on pubnet until the next one. "Implementation"'s "prices-api's once-a-month
    rotation limit isn't needed" no longer holds.
25. **No sign-in here.** Replaces decisions 2, 7, 10 and 11, and decision 4's `/login` and
    `/dashboard`: the Discord application, the session and the dashboard are the hub's. A key is
    issued only on a token whose `act` is `issue`, which the hub signs after a fresh Discord
    answer (its spec, "Getting a key").
26. **The secret is read once, when the backend starts, and it refuses to start without it** or
    with one that isn't `{"current", "previous"?}` of 32 bytes each in padded base64, as for its
    other secrets and decision 13. So Prices' `503 hub_unconfigured` has no case here; `503
    key_unavailable` is the database out of reach (a `502` since decision 36).
27. **Rate limits: by address for a call whose token doesn't verify, by the token's account for
    one that does** (60 a minute). Replaces decision 12. Every member's call comes from the hub's
    few addresses, so a limit by address alone would count them as one; a stranger has no
    account to be counted by. An IPv6 address counts by its /56 (decision 36).
28. **A key without a copy that opens** (issued by the operator's script, or sealed under another
    key) is `active` with `details.showable: false`, and `reveal` answers `409 key_not_viewable`.
    The tab then offers no Show or Copy. Prices has no such key.
29. **A key's `key_id` is the first 12 hex digits of its SHA-256**, in answers and in logs, as
    this backend's logs had it. Logs carry `jti`, `act`, the outcome and `key_id`; never the
    token, the key, the secret or the Discord id (replaces decision 15's `discord:<id>` in this
    backend's logs; the hub's own logs name the account).
30. **The tab's Regenerate revokes and issues nothing**, as Prices' does: the new key is "Get API
    Key", once decision 24 allows it.
31. **In the hub:** one client for every product, taking the product's name (`x402_busy`,
    `x402_unavailable` beside Prices' own codes, which stay); the BFF reads the new
    secret only with `x402` in `HUB_PRODUCTS` (its role's grant comes with the BFF's own deploy,
    which the hub's repo doesn't hold yet); the
    hub's privacy policy gains x402's paragraph (the registry's row, the sealed copy), shown
    when `VITE_PRODUCTS` names `x402`. That paragraph is this task's fourth criterion.
32. **Cloudflare's Browser Integrity Check goes off for `x402-portal.sorobanscan.com`**, as for
    the facilitator's host: only the BFF calls it, and a server's request is answered 1010 with
    the check on. By a pull request in `soroban-infrastructure` (`cloudflare/x402.tf`, whose
    comment says the clients are browsers), not by hand, so Terraform's state keeps agreeing.
33. **Decision 22 stands, for another reason.** No page calls the backend any more, so CORS is
    gone; every route but `/health` needs the hub's token, which is the gate.
34. **The month's cap is read, then acted on, without a lock.** `issue` reads the account's keys
    and then writes a new one, so an issue whose read went stale while a revoke landed gives the
    account one more key in that month. Bounded: up to one extra key per stale issue, never two
    active keys (the partial unique index `api_keys_one_active`), no quota gained (the use is
    the account's, not the key's, 0107), and only by the account itself, through Discord round
    trips it runs in parallel. A lock, `pg_advisory_xact_lock` on the owner (no new grants), is
    deferred to a ban, decided in 0107 before 0126 (decision 35). Claude's, from the build;
    approved on 2026-11-20.
    Fixed beside it on 2026-11-20 (branch `lore-0106-revoke-copy-and-logs`): a revoke deletes the
    copies of the owner's revoked keys only (`AND state = 'revoked'`). Its delete is a second
    statement after the `UPDATE`, and in READ COMMITTED it saw an issue that committed in between,
    as one can when the revoke found no active key and so held no lock: the new key stayed active
    with its copy gone (`showable: false`, `reveal` `409`). The in-memory store revokes first and
    deletes the same. `packages/api-keys` 27 tests and `apps/portal` 100 pass; the two new
    PostgreSQL tests in `apps/facilitator/test/postgres.test.ts` (the interleaving forced, and a
    copy the operator's script left still deleted) were written but not run: no database that
    day.
35. **A revoke by the operator's script is not a ban.** `pnpm keys revoke` (0105) holds back a
    new key only until the month's end, as any revoke does: the cap reads `revoked_at` in
    `api_keys`, whoever set it, and nothing in the registry blocks an owner. Whether pubnet needs
    a ban is to decide before it opens, in 0107 (akot, 2026-11-20). Claude's, from the final
    review.
36. **A stranger's IPv6 address counts by its /56, and a store that failed is a `502`.** Decided
    by akot on 2026-11-19, from the review of #194. One /64 holds more addresses than any
    window, so a limit per address let one client rotate past it, with a `hub_call_refused` line
    for every call; the facilitator's limits count IPv6 per /56 already, with the same
    `ipKeyGenerator` (`express-rate-limit`, now a dependency of `apps/portal`). `key_unavailable`
    is a `502`, as Prices answers a control plane that failed: the hub calls again at once after
    a `503` only. Prices answers a timeout with a `503`; here a timeout is a failure like any
    other, a `502`. Changes decisions 26 and 27.
37. **The server keeps no log line past 30 days.** `deploy/logrotate/x402-logs.conf` rotates each
    file daily, empty or not (`ifempty`), or sooner past 100 MB (`maxsize`), keeps 10 and deletes
    any older than 30 days (`maxage 30`), with `copytruncate` as before. The hub's privacy policy
    keeps log lines up to 30 days, and both services' files need it: the portal's lines name a key
    (`key_id`), the facilitator's their caller (`discord:<id>` on pubnet). By size alone a quiet
    file never rotated, and logrotate reads `maxage` only when a file rotates, so `maxage 30`
    alone, as approved on 2026-11-20, would have changed nothing; the daily rotation was added in
    the build, and akot confirmed it on 2026-11-23. The facilitator's quiet files now keep about 10
    days on the server (CloudWatch keeps 30). Checked with logrotate 3.22 on a scratch
    tree: a line written once is gone after ten daily runs (it stayed with `notifempty` or with
    `size 100M`), a rotation 40 days old goes at the next rotation, a file past 100 MB rotates the
    same day. `@stellar-x402/deploy` 153 tests; ADR 0011, the runbook and `docs/monitoring.md`
    say the same.
