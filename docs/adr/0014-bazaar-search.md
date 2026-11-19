# ADR 0014: Search the Bazaar by words and by meaning in PostgreSQL, fused by rank

- Status: accepted
- Date: 2026-11-19

## Context

The RFP asks for `GET /discovery/search` "with natural language query and cursor pagination" and
for search with ranking (`docs/rfp/07-x402-facilitator-bazaar.md`). The upstream spec gives the
request a `query`, filters, an advisory `limit` and a `cursor`, and the response `partialResults`,
"`true` when additional matches were truncated" (x402 `specs/extensions/bazaar.md`).

The Panel Review response, the approved plan for Tranche #2, promises in §4 hybrid lexical and
dense retrieval fused with Reciprocal Rank Fusion (RRF), on ClickHouse, with a small self-hosted
sentence-transformer model "(e.g. `all-MiniLM-L6-v2`)" so that no external inference API is on the
request path. The fused score is one of three inputs to the ranking, with a quality score and a
curation bump. §3 reads `partialResults` as "the ranking pass hasn't finished", and asks for an
opaque cursor because the ranked set can shift.

What this has to fit:

- All facilitator state, the catalog included, is in one PostgreSQL database per network
  ([ADR 0012](0012-facilitator-state-store.md)); the M1 evidence already told SCF that Tranche #2's
  search is planned on it.
- The server is shared: our containers are limited to 1.875 GiB together while production serves
  testnet, and the facilitator to 512 MiB and one CPU ([ADR 0011](0011-facilitator-hosting.md)).
- The catalog is small. Testnet holds one listing; the largest public catalog, CDP's, held 34,782
  on 2026-11-18, 1,637 of them on Stellar pubnet, all with English descriptions.

The measurements are in
[R-search-measurement](../../lore/1-tasks/active/0134_RESEARCH_search-in-postgres/notes/R-search-measurement.md).

## Decision

- **What is searched.** One text per listing, built from what the seller's 402 says (ADR 0008):
  the service name, the tags, the description, the words of the URL path, and for an MCP listing
  the tool name and its parameters. Both parts read the same text.
- **Words.** PostgreSQL's own full-text search, the `english` configuration:
  - a weighted `tsvector` column, generated from the listing's fields, with a GIN index. Weights
    start at name 1.0, tags 0.67, description 0.5, parameters 0.33;
  - the query's words are OR-ed, so a long sentence still matches, and ranked by `ts_rank_cd`.
- **Meaning.**
  - The model is `ibm-granite/granite-embedding-30m-english`: 30M parameters, 384 dimensions,
    Apache-2.0, CLS pooling, no query prefix. Listings and queries are embedded the same way and
    the vectors normalized.
  - Vectors are a `vector(384)` column in the listing's table, from `pgvector`, in a PostgreSQL
    image we build on the official `postgres:18` with the `postgresql-18-pgvector` package.
  - Search compares the query's vector with every listing's of that network (an exact scan, no
    index).
- **Where the model runs.**
  - In a container of its own, with its own memory limit, reached by the facilitator over the
    environment's internal network. The model file is in the image, pinned by its revision, so
    nothing is downloaded when it starts.
  - It holds no database password: the facilitator claims a job row per listing to embed
    (`FOR UPDATE SKIP LOCKED`, as the prune of `catalog_attempts` claims rows), asks the
    container for the vector and writes it.
  - The runtime is ONNX Runtime; 0120 picks the library, with no LGPL dependency
    (`docs/scf/milestone-1-license-audit.md`).
- **Fusion.** Weighted RRF over each part's top 50, k = 60: a listing scores
  3 / (60 + its rank by meaning) + 1 / (60 + its rank by words). Ties go by the listing's key.
- **Tuning.** The weights here are starting points, measured on 0134's 3,000 listings. Any tuning
  is done on that set or a larger one of the same kind, never on 0135's evaluation set, which only
  scores the ranking, so its nDCG@10 is not fitted to it.
- **When a listing has no vector yet.** A new listing joins search only once its vector is stored,
  so a search never mixes listings that were scored two ways. `/discovery/resources` lists it at
  once. A listing whose text changes keeps its old vector until the job writes the new one.
- **When the model is down.** The facilitator ranks by words alone, in the same response shape,
  and logs each fallback with its cause and counts it in a metric that monitoring can alert on.
- **Quality score and curation.** Not part of this ADR (task 0154). Until they exist, the order is
  the fused score alone.
- **Network.** A search reads one network's store. A search without a `network` filter follows the
  rule 0126 sets for `/discovery/resources`.
- **Cursor.** Opaque to the client; it carries the last result's fused score and listing key, and
  the next page starts after it. When listings change between two requests, a result may repeat
  or be skipped at a page boundary.
- **`partialResults`** keeps the spec's meaning: `true` when matches were cut that no page will
  return. Only the words part has a set of matches, the listings that hold a query word; it is
  `true` when that set is larger than the 50 candidates taken from it. The meaning part ranks
  every listing, so it has no matches to cut.

## Rationale

- **Meaning carries the search; words help where the query names the thing.** On 3,000 real
  catalog listings and 40 queries, words alone score nDCG@10 0.436 and miss paraphrases (0.189)
  and typos (0.288). granite alone scores 0.715, fused 3 : 1 0.706: fusion lifts keyword
  queries (0.665 → 0.723) and costs long ones (0.798 → 0.710). Both parts are kept because §4
  promises both.
- **Equal-weight RRF loses to meaning alone** (bge-small R@20 −0.061, 95% CI −0.109 .. −0.015):
  the words list pushes weak matches up. Weighting meaning 3 : 1 removes the loss.
- **granite gives the best small model's quality at the smallest model's cost.** On ToolRet's
  7,961 queries it scores nDCG@10 32.75, bge-small 32.20, `all-MiniLM-L6-v2` 26.23; on our test
  0.706, 0.700 and 0.640. It embeds a listing in 8.4 ms and a query in 1.5 ms on an M4, half of
  bge-small's time, at 371 MB peak.
- **PostgreSQL's own full-text search stands in for §4's token table.** It ranks by how often and
  how close the query's words occur, without the rarity weight (IDF) a TF-IDF score adds, and
  needs no table of our own to keep up to date. Words are a quarter of the fused score.
- **Typos need no trigram index.** The meaning part handles them: fused 0.672 against words-only
  0.288 on typo queries.
- **An exact scan is enough at this size.** 3,000 vectors scan in 0.18 ms; the whole public
  catalog of all networks is about twelve times that.
- **A container of its own** keeps the model's memory out of the facilitator's 512 MiB and its
  CPU off the `/settle` path, and lets search fall back to words when it is down.
- **A listing joins search whole.** A listing ranked by words only, among listings ranked by both,
  would sit too low; holding it back until its vector exists keeps one scoring for all.

## Alternatives considered

- **ClickHouse, as §4 names.** All state is in PostgreSQL (ADR 0012). Rejected.
- **Words only.** nDCG@10 0.436 against 0.706; misses paraphrases and typos. Rejected.
- **Meaning only.** Within noise of fused on our test, but §4 promises both, and keyword queries
  gain from words (0.665 → 0.723). Rejected for now.
- **Equal-weight RRF.** Worse than meaning alone. Rejected.
- **`all-MiniLM-L6-v2`, §4's example.** −5.97 nDCG@10 on ToolRet and −0.060 on our test against
  bge-small, both outside noise. Rejected.
- **`bge-small-en-v1.5`.** The same quality as granite at twice its time, and it needs a query
  prefix. Rejected.
- **`bge-base-en-v1.5`.** +2.18 on ToolRet, no gain on our test (−0.017), almost twice granite's
  memory (710 MB, 38% of today's container budget), six times its query time, and vectors twice
  the size. Rejected.
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

- Production needs our own PostgreSQL image with `pgvector`, and one more container whose memory
  limit is set from a measurement on the server.
- A new listing is found by search once the job has embedded it, later than `/discovery/resources`
  lists it. While the model is down, new listings wait and search answers by words alone.
- Paging ends with the fused candidates: a query reaches at most 100 listings, and
  `partialResults` says when more matched.
- Changing the model means embedding every listing again: about 5 minutes for 34,782 listings at
  granite's speed on an M4. A model of another size also changes the column's type.
- Differences from the Panel Review response go to the M2 evidence (task 0132): PostgreSQL instead
  of ClickHouse, full-text search instead of a token table, granite instead of the example model,
  RRF weighted 3 : 1, more fields searched, and `partialResults` in the spec's meaning.

## References

- [ADR 0008](0008-bazaar-catalog-integrity.md), [ADR 0011](0011-facilitator-hosting.md),
  [ADR 0012](0012-facilitator-state-store.md)
- [Task 0134](../../lore/1-tasks/active/0134_RESEARCH_search-in-postgres/README.md) and its
  [measurement](../../lore/1-tasks/active/0134_RESEARCH_search-in-postgres/notes/R-search-measurement.md);
  tasks 0120 (the route), 0135 (the evaluation set), 0154 (quality score and curation)
- ToolRet: `mangopy/ToolRet-Queries`, `mangopy/ToolRet-Tools` (MTEB task `ToolRetrieval`)
