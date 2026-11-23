---
title: "What each 0107 option closes in the threat model"
type: research
status: mature
tags: [facilitator, fees, budgets, security, threat-model]
history:
  - date: "2026-11-23"
    status: mature
    who: akot
    note: "Walk through docs/threat-model.md for the decisions 0107 has to make."
---

# What each 0107 option closes in the threat model

The threats are `docs/threat-model.md`'s: "Shared budget exhaustion by Sybil self-payments",
"Targeted `payTo` budget exhaustion", "Fee inflation by rent", and from "API keys": "A key leaks"
and "A new key for a new budget". Each section says what the options for 0107's decisions close
and what they leave. The code facts are from [R-codebase-map](R-codebase-map.md), the numbers from
[R-fee-numbers](R-fee-numbers.md).

> **After the design (2026-11-23).** This note assumed a monthly fee budget of 5 XLM per account
> and looked only at an attacker calling with its own key. The design's builder check found the
> other route: a seller's own key carries its buyers' payments. The design replaced the monthly
> fee budget with a daily one and accepted what is left; [S-design](S-design.md), "Residual risk",
> has the current figures.

## Figures used below

These are proposals, not decisions; the design settles them.

| Symbol | Value | Where from |
|---|---|---|
| `Q`, a free account's quota | 1,000 settlements a month | the task, CDP's model |
| `B_key`, a free account's fee budget | 50,000,000 stroops (5 XLM) a month | R-fee-numbers §5: 4 × 1,000 typical |
| `C`, the fee ceiling | 250,000 stroops; every settlement reserves it | `config.ts:184`, `policy.ts:205` |
| `f_typ`, a typical pubnet settlement | 12,203 stroops charged | R-fee-numbers §1, measured |
| `B_free`, all free accounts together | 250,000,000 stroops (25 XLM) per 24 h | R-fee-numbers §5 |
| `global` | 500,000,000 stroops (50 XLM) per 24 h, as today | `config.ts:257` |
| `payTo` budget | 100,000,000 stroops (10 XLM) per 24 h, as today | `config.ts:260` |
| The float | 100 XLM, alarms at 25 and 10 XLM, floor 5 XLM | ADR 0013, ADR 0007 |

An attacker can make each settlement cost close to `C`, at no cost to itself: a C-address payer
whose own `__check_auth` burns instructions (R-fee-numbers §2). So the worst case below is "every
settlement costs the ceiling", and the typical case is a G-address payer at `f_typ`.

## Before 0107: keys alone don't close anything

Since 0105 a pubnet `/settle` needs a key, but the spend policy ignores `ctx.caller`
(`policy.ts:188`; `test/spend-policy.test.ts:192-198` pins it). One key with free payer addresses
fills `asset:USDC` (25 XLM per 24 h) in about 1,000 ceiling settlements, or 20,500 typical ones,
under its rate limit of 600 a minute. So the key adds a name to the attack, not a bound. That is
why `config.ts:373` still refuses pubnet until 0107.

## 1. Shared budget exhaustion by Sybil self-payments

**With 0107 as the task has it** (a keyed settlement counts in its account's quota and fee budget,
in `B_free` while the account is on the free tier, and in `global`; not in `asset:` or `tier:other`):

- **One account can't fill `B_free`.** It stops at `Q` settlements or `B_key` (5 XLM) a month,
  whichever comes first, and `B_free` is 25 XLM a day.
- **Filling `B_free` for a day takes 5 accounts** at the ceiling (25 ÷ 5), or 21 at the typical fee
  (25 ÷ 1.22).
- **Keeping it full for a month takes about 150 accounts** at the ceiling (30 × 25 ÷ 5), or about
  615 at the typical fee. Each one is a Discord account in Stellar Developers that cleared its
  screening and is older than 5 minutes (0106).
- **Accounts with a raised limit keep settling.** They count in `global`, not in `B_free`, and
  `global` − `B_free` = 25 XLM a day is theirs. That is the task's third criterion.
- **USDC is no longer a lever.** Keyed traffic leaves `asset:USDC`. On pubnet every `/settle` has a
  key, so `asset:` and `tier:other` then bound nothing there; they stay on testnet.

**What it leaves:**

- **The free tier's availability.** Five accounts refuse every free account for a day; 150 do it
  for a month. It is the residual the task accepts ("many accounts use up only the free traffic").
- **The loss bounds the rate, not the sum.** At 25 XLM a day, `B_free` takes the 100 XLM float to
  its 25 XLM alarm in 3 days and to the 5 XLM floor in about 4. The floor then refuses everyone,
  raised accounts too, until a top-up. That is 0024's residual, moved from addresses to Discord
  accounts. The most an attacker can make us spend in a month is
  `min(accounts × B_key, 30 × B_free)` = 750 XLM, about $96 at $0.128 (R-fee-numbers §4).
  Two ways to bound the sum:
  - a monthly cap on `B_free` beside the daily one: the sum is bounded, but once it is spent, free
    accounts are refused until the month ends;
  - a smaller `B_key`: at 2.5 XLM it takes 300 accounts a month.

**Options for the quota's unit (decision 2):**

| Option | One account's worst month | Accounts to fill `B_free` for a day |
|---|---|---|
| Count only (`Q`) | `Q × C` = 25 XLM | 1 |
| Fees only (`B_key`) | 5 XLM, but a seller can't tell how many settlements that is | 5 |
| Both, as the task proposes | 5 XLM, and a count the seller understands | 5 |

So the count alone is weaker than the task's version by five times.

**Options for the month (decision 3):** a calendar month lets an account spend `Q` at the end of
one month and `Q` again at the start of the next, so `2 × Q` in a day. `B_free` per 24 h bounds
that burst whatever the month is. A rolling 30 days has no such edge, and no single instant at
which an account gets its quota back.

## 2. Targeted `payTo` budget exhaustion

The attack: fill one seller's `payTo` budget (10 XLM a day) with payments to it, so the seller's
own payments are refused.

| Option for keyed traffic (decision 1) | What it closes | What it leaves |
|---|---|---|
| **A.** `payer:` and `payTo:` stay as they are, shared by every caller | nothing new | 2 accounts at the ceiling fill a seller's `payTo` for a day (2 × 5 XLM), 60 keep it full for a month; those payments also use up `B_free` |
| **B.** `payTo:` kept per caller, e.g. `payTo:<addr>` under `owner:<id>` | the attack: an attacker's payments count in its own scope, the seller's own in the seller's | a scope per (account, `payTo`) that bounds less than the account's own budget does |
| **C.** No `payer:` or `payTo:` budget for keyed traffic: the account's budgets, `B_free` and `global` | the attack, since no budget is shared by callers below `B_free` | nothing for `payTo`; a payer address is no longer bounded across accounts, which bounded one address, not one attacker (ADR 0007, 2026-10-30) |

- In x402 the caller of `/settle` is the seller's resource server, so a seller's own traffic comes
  with its own key. With B or C, someone else's key can't spend that seller's budget.
- B bounds nothing that C doesn't: a free account's `B_key` (5 XLM a month) is below one day's
  `payTo` budget.
- C also drops the per-payer limit (2 XLM a day per payer), which a busy buyer agent paying many
  sellers could reach. With C that limit stays on testnet only.
- The breakers (payer, `payTo`, wasm asset) are not budgets and are not part of this decision.
  They stay as they are on both networks.

## 3. Fee inflation by rent

- **Per settlement: unchanged.** `C` still caps the fee field, and every settlement reserves it.
- **Per account: new.** Whatever the rent, an account makes us pay at most `B_key` a month, and all
  free accounts together at most `B_free` a day. Without a fee budget (count only) it would be
  `Q × C`.
- **The new `payTo` balance (decision 4).** A USDC payment to a fresh C-address balance has a fee
  field of about 443,000 stroops and is charged about 382,000 (R-fee-numbers §2), so it is refused
  under `C` today. At ten times the rent it would be about 4.3 million.

| Option | What it closes | What it leaves, or costs |
|---|---|---|
| **Keep refusing it** under `C` | a `payTo` rotation can't make us pay rent: every fresh balance is refused | a C-address seller first creates its own balance from its own account (about 0.04 XLM today); the refusal today names only the fee and the ceiling |
| **Pay it, counted in the account's budget**, with a higher ceiling for such a payment | the seller's first payment works | every settlement reserves `C`, so a higher ceiling raises every reservation. Paying it needs a reservation of the simulated fee instead, which 0024 decided against (S-design §5, "a budget is never exceeded"). A `payTo` rotation then costs us up to `B_key` an account a month: no new bound, but fewer settlements in it. At ten times the rent, about 11 creations exhaust `B_key`. |
| **Pay it only when the seller and the facilitator both opt in** (Solana's `ataCreationRequired`, `ataCreationSponsored`) | as above, and only for sellers who ask | needs the Stellar `exact` scheme to name such a field upstream, which it doesn't. The Solana spec itself says this rent "is not bounded over time" and asks sponsors to track it per owner (R-prior-art §2). |

- **Not this task's, but it gets closer:** at ten times the rent a C balance's TTL extension costs
  100,000–1,070,000 stroops. Settlements to or from C-addresses would then be refused at times
  under `C`. That is the fee ceiling's question (0010), not the quota's.

## 4. API keys: a leaked key, a new key for a new budget

- **A key leaks.** Since 0105 the thief uses up the owner's rate budget; with 0107 it also uses up
  the owner's quota and fee budget. The loss stops there, and that is the fix. The owner is then
  refused until the month ends or the operator raises its limit (decision 6). A revoked key's
  replacement waits for the next month anyway (0106 decision 24, accepted there).
- **A new key for a new budget.** It is closed only if the quota counts by owner, not by key
  (`discord:<id>`, the owner the limiter already counts by). 0106's third criterion was ticked on
  that promise, so 0107 needs a test: an account uses part of its quota, revokes, gets a new key,
  and its use carries over.
- **A ban (decision 5, 0106 decision 35).** A ban doesn't stop a Sybil with many accounts. Against
  one abusive account it saves at most `B_key` a month, since the quota already stops it. If the
  operator sets limits per owner in the registry (decision 6), a limit of 0 already works as a ban
  for settlement. It is kept by owner, so a new key doesn't lift it, and it needs no new state in
  `api_keys`. Removing the account from the Stellar Developers server stops it at the hub's gate.
- **The month's cap without a lock (0106 decision 34).** A stale `issue` gives an account one more
  key in a month. With use counted by owner it gains no quota, and a limit of 0 kept by owner holds
  for the new key too. The lock is needed only if a ban becomes a state the portal reads before it
  issues.

## 5. Who pays for a reopened settlement (decision 7)

- **A reopen happens only after a refusal that sent nothing** (`UNSENT_REASONS`, `reasons.ts:139-155`,
  such as `…_timeout` or `…_spend_store_unavailable`), and that claim's reservation was released by
  its `onFinal` or never made. The reopen reserves again under `<key>#<n+1>`, with the reopening
  request's caller (`hooks.ts:30-34`). So whoever sends the payload again pays for it, and no
  account's quota pays for a settlement it didn't send.
- **Can someone make another account pay?** Only by sending with that account's key. A third party
  holding the payload can reopen it with its own key: then it pays, and the first seller gets
  `…_already_settled` for a payment that landed. That is the threat model's "Payload
  front-running", unchanged by 0107.
- **A plain repeat** replays the stored answer: no reservation, no count, whoever sends it.
- **A quota refusal doesn't reopen**, like every spend limit. The buyer signs a new payment once
  the account has quota again. Making it reopen would add a deliberate refusal to the list of
  transient ones; it would also help little, since the payer's auth expires in about 7 minutes and
  a month's roll or an operator's raise comes much later.

## 6. Paths the policy doesn't see yet

- **A pubnet `/settle` without a caller.** Only `app.ts:309` calls `Settle`, and on pubnet `admit`
  always sets the caller. A caller added later that passes none would skip every account budget.
  The policy should refuse a pubnet settlement without a caller (fail closed), not count it in the
  shared budgets.
- **`/verify` checks no budget.** An account past its quota passes `/verify`, the seller serves,
  and `/settle` refuses. That costs the seller one response, not us any fee. A check at `/verify`
  helps honest sellers; it doesn't close an attack.
