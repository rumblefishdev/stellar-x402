# ADR 0014: Search the Bazaar by words and by meaning in PostgreSQL, fused by rank

- Status: accepted
- Date: 2026-11-19

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
  ([ADR 0012](0012-facilitator-state-store.md)); which of them holds the catalog is still open
  (task 0126). The M1 evidence already told SCF that Tranche #2's search is planned on PostgreSQL.
- The server is shared: our containers were limited to 1.875 GiB together while production serves
  testnet, and the facilitator to 512 MiB and one CPU ([ADR 0011](0011-facilitator-hosting.md)).
  The server itself has 125 GiB, so ADR 0011 now adds 512 MiB for the model.
- The catalog is small. Testnet holds one listing; the largest public catalog, CDP's, held 34,782
  on 2026-11-18, 1,637 of them on Stellar pubnet from 21 hosts, all with English descriptions.

The measurements are in
[R-search-measurement](../../lore/1-tasks/active/0134_RESEARCH_search-in-postgres/notes/R-search-measurement.md).

## Decision

- **What is searched.** One text per listing, built from what the seller's 402 says (ADR 0008),
  in four fields:
  - name: the service name, an MCP listing's tool name and the words of the URL path;
  - tags;
  - description: the listing's and its input schema's;
  - parameters: the names and descriptions of the inputs a listing takes, an HTTP listing's query
    and body fields or an MCP tool's arguments, at most 40, each cut at 300 characters.

  The fields are built once, by one SQL function over the stored listing, into a stored generated
  column. The words part, the meaning part and the text's hash all read that column, so they can't
  disagree about what a listing says.

- **Matches.** A listing matches a query when its meaning is close enough: cosine similarity
  0.60 or more (below). Words never add a listing; they only order the listings that match. On
  the 0134 set this keeps 97% of the relevant listings and the same nDCG@10 (0.724 against 0.725),
  with a median of 158 matches instead of 556, since OR-ed words match almost every listing
  through words such as "api". When the model can't be used, the listings that hold a query word
  match instead.
- **Filters.** `network`, `type`, `payTo`, `scheme` and `extensions` apply before anything is
  ranked, so a filtered query ranks among the listings that pass.
- **Words.** PostgreSQL's own full-text search, the `english` configuration:
  - a weighted `tsvector` from the fields, with a GIN index. Weights start at name 1.0, tags 0.67,
    description 0.5, parameters 0.33;
  - the query's words are OR-ed, so a long sentence still matches, and ranked by `ts_rank_cd`.
- **Meaning.**
  - The model is `ibm-granite/granite-embedding-30m-english`: 30M parameters, 384 dimensions,
    Apache-2.0, CLS pooling, no query prefix, inputs cut at 512 tokens. Listings and queries are
    embedded the same way and the vectors normalized. The meaning part reads the fields joined,
    cut at 2,000 characters.
  - Vectors are a `vector(384)` column in the catalog table, from `pgvector`. Each stores the
    model that made it and the hash of the text it was made from; search reads only vectors of the
    current model.
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
    environment's internal network. The model file is in the image, pinned by its revision, so
    nothing is downloaded when it starts.
  - It holds no database password. The facilitator reads listings whose vector is missing or
    stale (another model, another text hash), asks the container for each vector without holding
    a lock, and writes it only `WHERE` the text hash is still the one it embedded. The catalog row
    is the only record of what needs a vector.
  - The facilitator sends the container one listing at a time, so a backlog never takes the CPU
    that queries need.
  - A listing the container fails on is tried again on the next pass. Failures are logged with
    their cause and counted in a metric, so monitoring can alert on a listing that keeps failing.
  - The runtime is ONNX Runtime; 0120 picks the library, with no LGPL dependency
    (`docs/scf/milestone-1-license-audit.md`).
- **Fusion.** Weighted RRF over the top 50 matches by each part, k = 20: a listing scores
  4 / (20 + its rank by meaning) + 1 / (20 + its rank by words). Ties go by the listing's key.
- **Tuning.** These values sit on a flat part of the measured curve, within noise of meaning
  alone. Any tuning is done on 0134's set or a larger one of the same kind, never on 0135's
  evaluation set, which only scores the ranking, so its nDCG@10 is not fitted to it.
- **When a listing has no vector yet.** A new listing joins search only once its vector is stored,
  so a search never mixes listings that were scored two ways. `/discovery/resources` lists it at
  once. A listing whose text changes keeps its old vector until the new one is written.
- **When the model can't be used.** The facilitator ranks by words alone, in the same response
  shape, when the container doesn't answer within a timeout (0120 sets it from a measurement on
  the server) and while a new model's vectors are being written for the network. Every listing is
  then scored one way, so the answer includes listings with no current vector. Each fallback is
  logged with its cause and counted in a metric that monitoring can alert on.
- **Quality score and curation.** Task 0154 adds them, and decides what a listing without a
  quality score gets. Until then the fused score is the whole ranking.
- **When the ranking is served.** As §4 promises (task 0135), the ranking replaces curation-only
  mode only once 0135's run reaches nDCG@10 ≥ 0.75. Curation-only mode is 0154's to define.
- **Network.** A search reads one network's store. A search without a `network` filter follows the
  rule 0126 sets for `/discovery/resources`.
- **Cursor.** Opaque to the client; it carries the last result's score and listing key, and the
  next page starts after it. Each new listing above it shifts the next page by one, so a result
  may repeat or be skipped at a page boundary. It also carries how the page was ranked, fused or
  words alone, and the model: the two scores differ in scale, so a cursor from another ranking or
  model is refused with `400` and the client starts again.
- **`partialResults`** keeps the spec's meaning: `true` when matches were cut that no page will
  return: when more listings match than the 50 each part takes.

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
  M4, and the whole public catalog of all networks is about twelve times that. pgvector's scan
  inside PostgreSQL is not measured yet; 0120 measures it on the server, with the vector stored in
  line (`SET STORAGE PLAIN`), as pgvector's README suggests for scans.
- **A container of its own** keeps the model's memory out of the facilitator's 512 MiB and its
  CPU off the `/settle` path, and lets search fall back to words when it is down.
- **A listing joins search whole.** A listing ranked by words only, among listings ranked by both,
  would sit too low; holding it back until its vector exists keeps one scoring for all.

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
- **The model inside the facilitator.** Its 512 MiB and one CPU serve `/settle`. Rejected.
- **BM25 or TF-IDF over a token table of our own, as §4 describes.** It may rank words better than
  `ts_rank_cd`, but adds a table and its upkeep; not measured here.
- **`pg_trgm` for typos.** The meaning part already handles them. Not needed yet.
- **An approximate vector index (HNSW).** Not needed at this size. Added when a measurement on the
  server shows the scan is too slow.
- **Listing a new listing at once, ranked by words only, with `partialResults: true`** (§3's
  reading). Mixes two scorings and changes the spec's meaning of the field. Rejected.

## Consequences

- Production, CI and local compose switch to the pgvector image pinned as above, and one
  more container, limited to 512 MiB, which ADR 0011's totals now count.
- Adding the stored generated column rewrites the catalog table. On today's catalog that is one
  row; changing how the fields are built later, on a large catalog, needs a plain column, a
  trigger and a backfill, to stay within ADR 0012's online-migration limits.
- A seller can repeat words in its listing to rise in the words ranking, since `ts_rank_cd` counts
  each occurrence. Parameters are capped above; name, tags and description only by ADR 0008's
  listing limit. Fusion takes ranks, not scores, which bounds the gain, but the effect of
  repetition on the vector is not measured. Limits on it belong with the quality score (0154).
- A new listing is found by search once its vector is written, later than `/discovery/resources`
  lists it. While the model can't be used, search answers by words alone.
- Paging ends with the fused candidates: a query reaches at most 100 listings, and
  `partialResults` says when more matched.
- Changing the model means embedding every listing again: about 5 minutes for 34,782 listings at
  granite's speed on an M4, while search answers by words alone. A model of another size also
  changes the column's type.
- Differences from the Panel Review response go to the M2 evidence (task 0132).

## References

- [ADR 0008](0008-bazaar-catalog-integrity.md), [ADR 0011](0011-facilitator-hosting.md),
  [ADR 0012](0012-facilitator-state-store.md)
- [Task 0134](../../lore/1-tasks/active/0134_RESEARCH_search-in-postgres/README.md) and its
  [measurement](../../lore/1-tasks/active/0134_RESEARCH_search-in-postgres/notes/R-search-measurement.md);
  tasks 0120 (the route), 0126 (both networks in one process), 0135 (the evaluation set), 0154
  (quality score and curation)
- ToolRet: `mangopy/ToolRet-Queries`, `mangopy/ToolRet-Tools` (MTEB task `ToolRetrieval`)
- pgvector: `github.com/pgvector/pgvector`, README (storage, exact search)
