---
id: "0132"
title: "M2 evidence package for SCF's Tranche 2 verification"
type: DOCS
status: backlog
milestone: 2
owner: okarcz
related_adr: []
related_tasks: ["0128", "0120", "0034", "0102", "0121", "0135", "0136", "0137"]
tags: [scf, evidence, docs, priority-high, effort-medium, payments]
links:
  - ../../../docs/scf/README.md
  - ../../../docs/scf/milestone-1-evidence.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan. Raised in the plan's review: M1's package
      (0128) took 14 commits and the whole last day, so M2's starts in week 1.
  - date: "2026-11-16"
    status: backlog
    who: okarcz
    note: >
      okarcz takes ownership; a deviation row records the upto replay nonce change after the #3781 review.
---

# M2 evidence package for SCF's Tranche 2 verification

## Summary

As the team asking SCF for Tranche #2, we want the evidence document to grow with the work, so the
last days of the milestone go to checking it, not to writing it.

## Context

- Tranche #2 has six line items in the Panel Review response's budget (§1), 9.0 dev-weeks:
  - D1: Bazaar search and ranking engine, with its nDCG@10 evaluation (0120, 0135, 0154, 0070);
  - D2: MCP discovery server, search and paid-call tools (0042, 0068, 0085, 0137);
    0137's evidence: a search, then a paid call on its result, on testnet (scenario E-25,
    transaction `a94b6cb6793a15d9dd55d8c1860e53f303fe268f5510f40758401dfa4e19b1c4`), in
    `apps/mcp-local/e2e/results/testnet-results.json` once PR #245 merges;
  - D3: `scheme_upto_stellar.md` finalized and submitted to the TSC (0034);
  - D4: SDK helpers, TypeScript (0102, 0092);
  - D5: Rust seller crate, part 1 of 2 (0136);
  - D6: security audit engagement and dev-side preparation, through the SCF Audit Bank (0121).
- Two commitments repeat at every tranche boundary (0128): the dependency licence audit (§5) and
  the nDCG@10 run (§4).
- The Panel Review response is the approved tranche plan, and it is not in this repository. The
  M1 package quotes it; M2 planning had to read it from outside the repo.
- M1's package is the pattern: `docs/scf/milestone-1-*.md`, `build-pdf.sh`, a tag for the links.

### Deviations from the Panel Review response

| Line item | Promised (Panel Review) | Delivered | Why |
| --- | --- | --- | --- |
| D3 | §5, Replay: "our own proxy-contract nonce for `upto`" | UptoProxy stores no nonce; Soroban's auth-entry nonce makes each signed entry single-use, and the x402 `nonce` stays a signed payment ID in the arguments and the `upto_settled` event (ADR 0010 D6 amended, D12) | jeesunikim's review of upstream #3781 (2026-11-12), aligned with #3134; replay is still refused by the host (`Error(Auth, ExistingValue)`), shown in the 61/61 testnet run |
| D1 | §4: hybrid search "on ClickHouse" | PostgreSQL, where all facilitator state already is | ADR 0012, ADR 0014 |
| D1 | §4: lexical part as a TF-IDF-style score over a per-token document-frequency table, with `ngrambf_v1`-indexed candidate filtering | PostgreSQL's own full-text search (`ts_rank_cd`), no table of our own and no trigram index; typos are left to the meaning part, so words-only fallback has none | ADR 0014 |
| D1 | §4: a small self-hosted model, "e.g. `all-MiniLM-L6-v2`" | `granite-embedding-30m-english`, still small and self-hosted, in a container of its own (371 MB peak against the example's 252 MB) | ADR 0014: +6.5 nDCG@10 on ToolRet's 7,961 queries over the example model, at its speed |
| D1 | §4: RRF of the two parts | RRF weighted 4 : 1 for meaning, k = 20 | ADR 0014: equal weights scored below meaning alone |
| D1 | §4: `serviceName`, `tags`, `info` description searched | also the URL path's words, an MCP tool's name, and the parameters of every listing | ADR 0014 |
| D1 | §3: `partialResults` true while the ranking pass hasn't finished | the spec's meaning, "additional matches were truncated"; a listing joins search only once its vector is stored | ADR 0014 |
| D1 | §4.3: transaction volume is a quality input | only distinct paying wallets count | ADR 0014: repeating payments from one wallet costs the seller nothing |
| D1 | §4.3: recency of activity is a quality input | the 30-day window of paying wallets is the recency | ADR 0014 |
| D1 | §4.3: a hosting penalty for shared or tunnelling hosts | tunnel hosts only; shared hosting such as `workers.dev` gets none | ADR 0014: 580 of 1,292 Stellar listings in CDP's catalog (44.9%) are on `workers.dev` |
| D1 | §4: the quality score recomputed on a 6-hour cycle | computed at each search, from a table of payments per listing | ADR 0014 |
| D1 | §4: "curated ordering is used instead" until nDCG@10 ≥ 0.75 | no curation-only mode; search is not offered on pubnet until the run passes | ADR 0014: with no curated listing, a curated order equals the fused one |
| D1 | §4.3: a curation boost for verified, health-checked listings; §4: a bump for manually vetted listings | curated = the seller proved its `payTo` with `stellar.toml` (0070), checked by the facilitator, not vetted by hand; health stays with 0069; until 0070 lands no listing is curated | ADR 0014 |
| D1 | §4.3: metadata completeness, penalizing placeholder descriptions | only an empty description is penalized; placeholder text and other missing metadata are not | ADR 0014: no Stellar listing in CDP's catalog had an empty or placeholder description on 2026-11-23 |
| D1 | §4.3: buyer reach as a ranking input | added by 0154, but in M2 the factor is 1 for almost every listing: pubnet is refused and testnet had 2 paying wallets in 30 days | ADR 0014 |

## Implementation Plan

### Step 1: Skeleton (first week of M2)

- `docs/scf/milestone-2-evidence.md` with one section per line item D1–D6, each starting from its
  done signal, and `<TODO:>` markers for the evidence.
- Add the Panel Review response to `docs/scf/`, after okarcz confirms it may be public.

### Step 2: Evidence with the work

- The pull request that finishes a line item adds its evidence to that section: transaction
  hashes, the nDCG@10 result, links.

### Step 3: Package (last week of M2)

- Licence audit at the Tranche #2 boundary, the video scenario and recording, the form answers,
  the PDF and the tag.

## Acceptance Criteria

- [ ] Given the first week of M2, when it ends, then `docs/scf/milestone-2-evidence.md` exists with
      a section and a done signal for each of D1–D6
- [ ] The Panel Review response is in `docs/scf/`, or the task records why it stays out
- [ ] Given a finished line item, when its section is read, then every claim links to evidence in
      the repo or on chain, and no `<TODO:>` marker is left
- [ ] The dependency licence audit at the Tranche #2 boundary is committed with its commands
- [ ] The nDCG@10 result of 0135 is in the document, with the query set's commit
- [ ] The video scenario, the form answers and the PDF build exist as in M1, and a tag fixes the
      document's links
