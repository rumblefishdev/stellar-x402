# ADR 0014: Search the Bazaar by words and by meaning in PostgreSQL, fused by rank

- Status: accepted
- Date: 2026-11-19, amended 2026-11-20 (task 0155: one catalog for both networks), 2026-11-23
  (task 0154: the quality score) and 2026-11-24 (task 0120: each listing's search card in a table
  of its own; the vector on the card, the model's own server in the facilitator's image, when
  vectors are written, the timeout, and no words-only window for a model change)

## Context

The RFP asks for `GET /discovery/search` "with natural language query and cursor pagination" and
for search with ranking (`docs/rfp/07-x402-facilitator-bazaar.md`). The upstream spec gives the
request a `query`, the filters `type`, `payTo`, `scheme`, `network` and `extensions`, an advisory
`limit` and a `cursor` the server may ignore, and the response `partialResults`, "`true` when
additional matches were truncated" (x402 `specs/extensions/bazaar.md`, `@x402/extensions`
`SearchDiscoveryResourcesParams`).

The Panel Review response, the approved plan for Tranche #2, promises in §4 hybrid lexical and
dense retrieval fused with Reciprocal Rank Fusion (RRF), on ClickHouse, with a small self-hosted
sentence-transformer model "(e.g. `all-MiniLM-L6-v2`)" so that no external inference API is on the
request path. The fused score is one of three inputs to the ranking, with a quality score and a
curation bump, and the ranking replaces curation-only mode only at nDCG@10 ≥ 0.75 on the team's
graded set. §3 reads `partialResults` as "the ranking pass hasn't finished", and asks for an
opaque cursor because the ranked set can shift.

What this has to fit:

- All facilitator state is in PostgreSQL, a database per network
  ([ADR 0012](0012-facilitator-state-store.md)); the catalog is one table for both networks
  (task 0155), and which database holds it is still open (task 0126). The M1 evidence already told SCF that Tranche #2's search is planned on PostgreSQL.
- The server is shared: our containers were limited to 1.875 GiB together while production serves
  testnet, and the facilitator to 512 MiB and one CPU ([ADR 0011](0011-facilitator-hosting.md)).
  The server itself has 125 GiB, so ADR 0011 now adds 768 MiB for the model.
- The catalog is small. Testnet holds one listing; the largest public catalog, CDP's, held 34,782
  on 2026-11-18, 1,637 of them on Stellar pubnet from 21 hosts, all with English descriptions.

The measurements are in
[R-search-measurement](../../lore/1-tasks/archive/0134_RESEARCH_search-in-postgres/notes/R-search-measurement.md).

## Decision

- **What is searched.** One text per listing, built from what the seller's 402 says (ADR 0008),
  in four fields:
  - name: the service name, an MCP listing's tool name and the words of the URL path;
  - tags;
  - description: the listing's, its input's own (an MCP tool's or an HTTP endpoint's) and its
    input schema's;
  - parameters: the names and descriptions of the inputs a listing takes, an HTTP listing's query
    and body fields or an MCP tool's arguments, each name once, at most 40 entries (a name or a description each), each cut at 300
    characters.

  One TypeScript function, `searchFields` in `@stellar-x402/bazaar`, builds the fields from the
  stored listing, next to the validator that knows its shape. They go into the listing's search
  card: a row of its own table, `catalog_search`, one per catalog listing, which the words part,
  the meaning part and the vector's write all read, so they can't disagree about what a listing says.
  The catalog's write stores the listing and its card in one statement, so search finds what the
  catalog holds from the moment it holds it. Each release, as it starts, rewrites every card once
  in the background with its own rules, so a change to the rules, the listings stored before cards
  existed and a rolled-back release all leave the cards matching their listings, unless the
  rewrite fails to read the catalog: then it stops, logs an error and the cards past that point
  wait for the next start. The catalog table is never rewritten for search.

- **Matches.** A listing matches a query when its meaning is close enough: cosine similarity
  0.60 or more (below). Words never add a listing; they only order the listings that match. On
  the 0134 set this keeps 97% of the relevant listings and the same nDCG@10 (0.724 against 0.725),
  with a median of 158 matches instead of 556, since OR-ed words match almost every listing
  through words such as "api". When the model can't be used, the listings that hold a query word
  match instead.
- **Filters.** `network`, `type`, `payTo`, `scheme` and `extensions` apply before anything is
  ranked, so a filtered query ranks among the listings that pass.
- **Words.** PostgreSQL's own full-text search, the `english` configuration:
  - a weighted `tsvector` from the card's fields, which PostgreSQL computes on each card write.
    Weights start at name 1.0, tags 0.67, description 0.5, parameters 0.33. A GIN index on the
    words: over CDP's 39,579 listings and the 0134 queries it halves the median query time
    (23.8 ms to 10.3 ms), most for queries of rare words;
  - the query's words are OR-ed, so a long sentence still matches, and ranked by `ts_rank_cd`.
- **Meaning.**
  - The model is `ibm-granite/granite-embedding-30m-english`: 30M parameters, 384 dimensions,
    Apache-2.0, CLS pooling, no query prefix. A listing is cut at 512 tokens, a query at 256
    (about 1,200 characters), so a long query costs about half as much; the queries measured (at
    most 31 tokens) are never cut. Listings and queries are otherwise embedded the same way and
    the vectors normalized. The meaning part reads the fields joined,
    cut at 2,000 characters.
  - Vectors, from `pgvector`, on the listing's search card: `embedding`, one vector per listing,
    with `model`, the model that made it; the write that changes the card's text clears both.
    Search reads only vectors of the current model.
  - Search compares the query's vector with every listing's that passes the filters (an exact
    scan, no index).
  - A listing whose cosine similarity to the query is below 0.60 is not a match, so a query
    with nothing related in the catalog finds nothing by meaning. On the 0134 set this floor keeps
    98% of the relevant listings. The testnet catalog's one weather listing scores 0.79–0.80 for
    weather queries and 0.47–0.53 for unrelated ones. The floor belongs to the model: a new model
    sets its own from the same kind of measurement.
- **The PostgreSQL image.** The pgvector project's own image, `pgvector/pgvector:0.8.7-pg18-trixie`,
  pinned by digest: the official `postgres:18-trixie` with pgvector built from its source tag. We
  build no image of our own. Production, CI, local compose and restores use that one image, and a
  PostgreSQL upgrade waits for pgvector's matching image. The extension is created once, in the
  `public` schema, so the tests' per-file schemas all see the type.
- **Where the model runs.**
  - In a container of its own, with its own memory limit, reached by the facilitator over the
    environment's internal network. It runs from the facilitator's image with a command of its
    own, as the migrations do, so one digest deploys both. The image's build fetches the model's
    files at the pinned revision, so nothing is downloaded when it starts.
  - The facilitator starts only once the model's container is healthy.
  - The server is our own Node process on `onnxruntime-node` 1.31.1, with the model's own
    tokenizer read by `@huggingface/tokenizers`: no LGPL dependency
    (`docs/scf/milestone-1-license-audit.md`).
  - It holds no database password. The facilitator computes a listing's vector right after the
    catalog writes the listing, and once at each start for every card without one, with no retry
    loop in between. The write that changes a card's text clears its vector, so a card holds a
    vector only of its current text. It asks the
    container for each vector without holding a lock, and writes it only `WHERE` the card's fields
    are still the ones it embedded, so a vector never lands on a newer text.
  - The facilitator sends the container one listing at a time, so a backlog never takes the CPU
    that queries need.
  - A listing the container fails on is tried again at the next start. Failures are logged with
    their cause and counted in a metric, so monitoring can alert on a listing that keeps failing.
- **Fusion.** Weighted RRF over every match, k = 20: a listing scores
  4 / (20 + its rank by meaning) + 1 / (20 + its rank by words), with no words term for a match
  that holds no query word. Ties go by the listing's key. Nothing is cut: on the 0134 set,
  ranking every match scores as well as ranking each part's top 50 (0.724 against 0.725
  nDCG@10), and with an exact scan a cut saves no work.
- **Tuning.** These values sit on a flat part of the measured curve, within noise of meaning
  alone. Any tuning is done on 0134's set or a larger one of the same kind, never on 0135's
  evaluation set, which only scores the ranking, so its nDCG@10 is not fitted to it.
- **When a listing has no vector yet.** A new listing joins search only once its vector is stored,
  so a search never mixes listings that were scored two ways. `/discovery/resources` lists it at
  once. A listing whose text changes leaves search by meaning until its new vector is written,
  right after the write.
- **When the model can't be used.** The facilitator ranks by words alone, in the same response
  shape, when the container doesn't answer within 2,000 ms or answers an error. The timeout stays
  until a measurement on the server sets it. Every listing is then scored one way, so the answer
  includes listings with no current vector. Each fallback is logged with its cause and counted in
  a metric that monitoring can alert on.
- **When the model changes.** No words-only window: the procedure is decided when a change comes,
  and until then search reads only the current model's vectors.
- **Quality score.** A listing's score is its fused score times a quality factor q (task 0154), in
  the fused ranking and in words alone:
  - q = (1 + 0.2 × p / (p + 2)) × 0.9 on a tunnel host × 0.9 with an empty description, where p is
    the number of distinct wallets that paid for the listing through this facilitator in the last
    30 days. q is at most 1.2, so it moves a listing only a few places: with 10 paying wallets
    the 4th match by meaning passes the 1st.
  - A listing with no payments, on its own host and with a description, gets q = 1: it is neither
    hidden nor raised, as §4.3 asks for new listings.
  - p's bonus grows quickly at first and then flattens: 1 wallet gives q = 1.07, 10 give 1.17,
    50 give 1.19.
  - A wallet paying its own `payTo` is not counted. Wallets the seller funded are counted.
  - Only distinct wallets count, not the number of payments.
  - The 30-day window is the recency: a listing last paid 31 days ago has p = 0.
  - Each network counts its own payments, testnet the same way as pubnet.
  - A tunnel host is one of `trycloudflare.com`, `ts.net`, `serveo.net`, `serveousercontent.com`,
    `ngrok.io`, `ngrok.app`, `ngrok-free.app`, `ngrok-free.dev`, `loca.lt`, `lhr.life`,
    `lhr.rocks`, `pinggy.link` and `pinggy-free.link`, or a name ending in a dot and one of them:
    `x.ts.net` is a tunnel host, `getbits.net` is not. Shared hosting such as `workers.dev` or
    `vercel.app` gets no penalty.
  - An empty description is a missing one, an empty one or one of spaces only. A short
    description gets no penalty.
  - q is computed when the search runs, from the payments stored at that moment.
- **How a payment reaches its listing.** A table holds one row per settled payment that names a
  listing: the settlement's key, the network, `payTo`, method, listing URL, payer and the time the
  row is written. The settlement's key makes the row unique, since a success can be reported twice, by settle and by
  reconcile. The cataloger writes the row right after it derives the listing's key from the
  payment, also when the listing's copy is unchanged. A settlement recorded twice keeps its first
  row. Rows are kept; the count reads the last 30
  days. The table starts empty when it ships. A failed write is logged.
- **Curation.** A listing is curated when its seller proved its `payTo` with `stellar.toml` (task
  0070). Task 0070 sets the bonus and how it meets the 1.2 cap. Until then no listing is curated.
- **When the ranking is served.** There is no separate curation-only mode. 0135's run decides
  when search is offered on pubnet (task 0120): not before it reaches nDCG@10 ≥ 0.75, as §4
  promises.
- **Network.** A search reads the one catalog, which holds both networks (task 0155): without a
  `network` filter it ranks both, as `/discovery/resources` lists both.
- **Cursor.** Opaque to the client; it carries the last result's score and listing key, and the
  next page starts after it. Each new listing above it shifts the next page by one, so a result
  may repeat or be skipped at a page boundary. It also carries how the page was ranked, fused or
  words alone, and the model: the two scores differ in scale, so a cursor from another ranking or
  model is refused with `400` and the client starts again.
- **`partialResults`** keeps the spec's meaning: `true` when matches were left out that no page
  will return. Every match is ranked and the cursor reaches the last one, so it is `false`, except
  while search answers by words alone: matches by meaning were not looked for, so it is `true`.

## Rationale

- **Meaning carries the search.** On 3,000 real catalog listings and 40 queries, words alone score
  nDCG@10 0.436, return nothing for 2 typo queries and no relevant listing in the top 10 for 9 of
  the 40; granite alone
  scores 0.715. Fused 4 : 1 at k = 20 scores 0.726, +0.012 (95% CI −0.005 .. +0.030) over meaning
  alone, within noise. On the 1,637 Stellar listings alone, the search a pubnet request makes,
  the order is the same: 0.722 fused, 0.713 meaning alone. Both parts are kept because §4
  promises both, and the fusion costs nothing measurable.
- **Equal-weight RRF loses to meaning alone**: −0.072 nDCG@10 (−0.125 .. −0.016) at k = 60. The
  words list pushes weak matches up; weighting meaning 2 to 6 times words, at k = 10 to 30, gives
  0.713 to 0.726, a flat stretch the chosen values sit in.
- **Long queries lose from fusion.** All 8 long-sentence queries score lower fused than by meaning
  alone (−0.088 at 3 : 1, k = 60, sign-flip p = 0.008); the other classes show no effect that
  survives 8 queries a class.
- **granite ties bge-small in quality at half its time.** On ToolRet's 7,961 queries it scores
  nDCG@10 32.75 against bge-small's 32.20 averaged per query, 27.11 against 27.93 averaged per
  subset; on our test 0.706 against 0.700. `all-MiniLM-L6-v2` is last on both (26.23, 0.640). It
  embeds a listing in 8.4 ms and a query in 1.5 ms on an M4, half of bge-small's time; its 371 MB
  peak is the most of the small models (MiniLM 252, bge-small 306).
- **PostgreSQL's own full-text search stands in for §4's token table.** It ranks by how often and
  how close the query's words occur, without the rarity weight (IDF) a TF-IDF score adds, and
  needs no table of our own to keep up to date.
- **Typos need no trigram index while the model runs.** The meaning part handles them: fused 0.672
  against words-only 0.288 on typo queries. Words-only fallback has no typo handling.
- **An exact scan is likely enough at this size.** 3,000 vectors scan in 0.18 ms in NumPy on an
  M4, and the whole public catalog of all networks is about twelve times that. In PostgreSQL 18
  with pgvector, with the vector stored in line (`SET STORAGE PLAIN`), the fused search took 4-14
  ms over 1,637 cards and 140-411 ms over 40,000 with a quarter matching; with all 40,000 matching
  and 32 common words it reached the 2 s statement timeout in 4 of 50 runs (random vectors,
  measured locally on arm64, 2026-11-25). The server's figure follows the first deploy.
- **A container of its own** keeps the model's memory out of the facilitator's 512 MiB and its
  CPU off the `/settle` path, and lets search fall back to words when it is down. Run from the
  facilitator's image, it needs no image, build or deploy step of its own.
- **A listing joins search whole.** A listing ranked by words only, among listings ranked by both,
  would sit too low; holding it back until its vector exists keeps one scoring for all.
- **Quality is a small correction, not a second ranking.** Adding CDP's payer counts to the fused
  score on 0134's set raised nDCG@10 from 0.726 to 0.733 at a weight of about 20% of the top fused
  score and kept it at 0.731 at 40%, then lowered it to 0.719 at 80% and to 0.632 at 200%. A 20%
  bound sits where it did no harm. Relevance grades can't show what quality is for, a service that works, so the
  measurement bounds the harm, not the gain. A bounded, saturating term is how search engines
  add a document's own evidence to its text score (Elasticsearch's `rank_feature` saturation,
  S / (S + pivot); Craswell et al., SIGIR 2005, for PageRank).
- **Fake payers buy little.** A seller can pay itself from fresh wallets, and the facilitator pays
  each network fee. Excluding wallets the seller funded would drop real payers too: 50 of 99 real
  pubnet payers were funded within two hops by the payee or its funder, as facilitators fund
  accounts for their users (task 0129, `notes/R-network-index-measurements.md`). The saturation
  bounds the gain instead: the first 10 fake wallets buy most of the bonus (q 1.17), and 40 more
  add 0.026. A seller paying its own
  `payTo` is cheap to tell apart, and it made 44% of the pubnet USDC payments shaped like x402
  settlements in the 30 days to 2026-11-23.
- **Volume is left out** because repeating payments from one wallet costs the seller nothing: the
  money returns to it and the facilitator pays the fee.
- **In M2 the payer term is almost always 1.** This facilitator settles testnet only (pubnet is
  refused, `apps/facilitator/src/config.ts`), with 2 paying wallets in the 30 days to 2026-11-23;
  the seeded pubnet listings have no payments through it. On pubnet, 34 `payTo` accounts had any
  paying wallet besides themselves in those 30 days, across all facilitators.
- **Tunnels and empty descriptions are rare.** On 2026-11-23, CDP's public catalog held 84
  listings on the tunnel hosts above out of 39,579 and 53 with an empty description, none of them
  on Stellar; the testnet catalog's one listing is on `trycloudflare.com`. `workers.dev` holds 580
  of the 1,292 Stellar listings there (44.9%), so a penalty for shared hosting would lower many
  real listings.
- **A table, because reading payments per search does not scale.** Deriving each payment's
  listing key from the stored settlements at search time took 36 ms at 155 payments in 30 days,
  219 ms at 2,539 (pubnet's 30-day volume across all facilitators) and 2.2 s at 25,000; the table
  answers in 0.9, 6.5 and 7.8 ms (local PostgreSQL, synthetic payments of 4.3 KB). The table ran
  with an index on all its columns; it ships with its key only, and an index comes when a
  measurement of the shipped search query needs it.
- **The numbers above** are in
  [R-quality-measurement](../../lore/1-tasks/active/0154_FEATURE_bazaar-quality-score/notes/R-quality-measurement.md).
- **Curation needs a proof, not a judgement.** A list kept by hand would have the operator vouch
  for sellers; a `stellar.toml` proof is checkable.

## Alternatives considered

- **ClickHouse, as §4 names.** All state is in PostgreSQL (ADR 0012). Rejected.
- **Words only.** nDCG@10 0.436 against 0.726; misses paraphrases and typos. Rejected.
- **Meaning only.** Within noise of fused on our test, but §4 promises both. Rejected for now.
- **Equal-weight RRF, and §4's unweighted fusion.** Worse than meaning alone. Rejected.
- **`all-MiniLM-L6-v2`, §4's example.** −5.97 nDCG@10 on ToolRet and −0.066 on our test against
  granite, both outside noise. Rejected.
- **`bge-small-en-v1.5`.** The same quality as granite at twice its time, and it needs a query
  prefix. Rejected.
- **`bge-base-en-v1.5`.** +1.63 nDCG@10 on ToolRet over granite; on our test −0.023 nDCG@10 and
  +0.013 R@20 (95% CI −0.052 .. +0.078), so no clear gain. With the floor and fusion tuned for it
  (its floor keeping 98% of relevant listings is 0.443), 0.702 nDCG@10 against granite's 0.725.
  Memory no longer decides: the server has room for its 710 MB. Rejected on quality.
- **An embedding API.** Puts an outside service on the request path, which §4 rules out. Rejected.
- **transformers.js for the model's server.** It runs the same ONNX model, but its dependency
  `sharp` ships libvips under LGPL-3.0, which the licence commitment rules out. Rejected.
- **The model inside the facilitator.** Its 512 MiB and one CPU serve `/settle`. Rejected.
- **BM25 or TF-IDF over a token table of our own, as §4 describes.** It may rank words better than
  `ts_rank_cd`, but adds a table and its upkeep; not measured here.
- **`pg_trgm` for typos.** The meaning part already handles them. Not needed yet.
- **An approximate vector index (HNSW).** Not needed at this size. Added when a measurement on the
  server shows the scan is too slow.
- **Listing a new listing at once, ranked by words only, with `partialResults: true`** (§3's
  reading). Mixes two scorings and changes the spec's meaning of the field. Rejected.
- **Quality as the first sort key.** A popular listing would beat a far better match. Rejected.
- **Quality only as a tie-break.** Fused scores rarely tie exactly, so it would change nothing.
  Rejected.
- **Transaction volume as an input, as §4.3 lists.** Free to fake. Rejected.
- **Leaving out wallets the seller funded.** Drops half the real payers. Rejected for now.
- **A separate recency term.** The 30-day window already is one. Rejected.
- **A penalty for shared hosting**, as §4.3 says ("shared/tunneling infrastructure"). Lowers most
  real listings. Rejected.
- **A penalty for short descriptions.** Real short names such as "Search Reddit posts" would lose.
  Rejected.
- **Recomputing every 6 hours, as §4 plans.** Counting at search time is cheaper and always
  current. Rejected.
- **Counting from the settlements at search time, without a table.** No migration, but too slow
  past about 1,000 payments in 30 days (above). Rejected.
- **CDP's per-listing activity fields.** The catalog reads no other catalog (task 0155), and they
  count CDP's traffic only. Rejected.
- **Payments across all facilitators, from the chain.** Real pubnet data today, but per `payTo`,
  not per listing, and the work of task 0129. Not in this grant.
- **A cap on listings from one host on a page.** It depends on the page, so the cursor can't carry
  it; the share of one host in the top 10 is measured once ranking runs. Not now.
- **A curation-only mode until 0135 passes.** With no curated listing it would equal the fused
  order. Rejected.

## Consequences

- Production, CI and local compose switch to the pgvector image pinned as above, and one
  more container, limited to 768 MiB, which ADR 0011's totals now count.
- The facilitator starts only once the model's container is healthy, so a model that never
  starts keeps the facilitator, and `/settle`, from starting too.
- The cards are a table of their own, added with a `CREATE TABLE` that touches no catalog row. A
  catalog column computed by PostgreSQL was the first shape: adding it rewrote the catalog under
  its lock (285–576 ms for 2,500 listings, 5.5 s for 35,000), and so would every later change to
  the fields, past what ADR 0012 lets a transactional migration hold.
- Each catalog write computes the card's fields, but only when the listing changes: a repeat
  payment whose copy is unchanged writes nothing. Each start rewrites every card; after a change
  to the rules, a card keeps the older rules' fields until the rewrite reaches it.
- A seller can repeat words in its listing to rise in the words ranking, since `ts_rank_cd` counts
  each occurrence. Parameters are capped above; name, tags and description only by ADR 0008's
  listing limit. Fusion takes ranks, not scores, which bounds the gain, but the effect of
  repetition on the vector is not measured. It stays a named risk, with no limit of its own: it
  pays mainly while search answers by words alone, and on 2026-11-23 no Stellar listing in CDP's
  catalog repeated a word 10 times in its description (17 of 39,577 did, all real services).
- A new listing is found by search once its vector is written, later than `/discovery/resources`
  lists it. While the model can't be used, search answers by words alone.
- Paging reaches every match. On the 0134 set a query has a median of 158 matches, 76 among the
  Stellar listings alone, and at most 744.
- Changing the model means embedding every listing again: about 5 minutes for 34,782 listings at
  granite's speed on an M4. How search answers meanwhile is decided when a change comes.
- The cursor carries the score with q in it. A payment between two pages can move a listing, as a
  new listing can.
- Changing how a payment's listing key is derived leaves old rows under the old key; the rows can
  be rebuilt from the settlements, which are kept.
- A listing whose seller stops answering keeps its place; task 0069 decides what it gets.
- Differences from the Panel Review response go to the M2 evidence (task 0132).

## References

- [ADR 0007](0007-fee-abuse-containment.md), [ADR 0008](0008-bazaar-catalog-integrity.md),
  [ADR 0011](0011-facilitator-hosting.md), [ADR 0012](0012-facilitator-state-store.md)
- [Task 0134](../../lore/1-tasks/archive/0134_RESEARCH_search-in-postgres/README.md) and its
  [measurement](../../lore/1-tasks/archive/0134_RESEARCH_search-in-postgres/notes/R-search-measurement.md);
  tasks 0120 (the route), 0126 (both networks in one process), 0135 (the evaluation set), 0154
  (quality score and curation) and its
  [measurement](../../lore/1-tasks/active/0154_FEATURE_bazaar-quality-score/notes/R-quality-measurement.md),
  0069 (dead listings), 0070 (the verified seller), 0129 (x402 payments across Stellar)
- Elasticsearch, `rank_feature` query, saturation function; N. Craswell, S. Robertson, H. Zaragoza,
  M. Taylor, "Relevance weighting for query independent evidence", SIGIR 2005
- ToolRet: `mangopy/ToolRet-Queries`, `mangopy/ToolRet-Tools` (MTEB task `ToolRetrieval`)
- pgvector: `github.com/pgvector/pgvector`, README (storage, exact search)
