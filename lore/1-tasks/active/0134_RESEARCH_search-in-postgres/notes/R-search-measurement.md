---
title: "Search: words, meaning and seven embedding models, measured"
type: research
status: mature
spawned_from: README.md
spawns: []
tags: [bazaar, search, embeddings, postgres, measurement]
links:
  - ../../../../../docs/adr/0014-bazaar-search.md
history:
  - date: "2026-11-19"
    status: mature
    who: karolkow
    note: "Words-only, meaning-only and fused search on 3,000 catalog listings and on ToolRet, for seven small embedding models."
---

# Search: words, meaning and seven embedding models, measured

Two measurements behind [ADR 0014](../../../../../docs/adr/0014-bazaar-search.md): our own test on
real catalog listings, which shows whether a method finds what an agent asks for, and ToolRet, a
public benchmark large enough to tell models apart. Times are from an Apple M4, one thread, batch 1,
Python with onnxruntime 1.32.0 and tokenizers 0.23.3; they are not the server's.

## Our test

- **Corpus:** 3,000 listings from CDP's public `/discovery/resources`, downloaded 2026-11-18: all
  1,637 Stellar pubnet listings and 1,363 others drawn with a fixed seed (`build_corpus.py`). Each
  listing gives one text: service name, tags, description, URL path words, parameter names and
  descriptions.
- **Queries:** 40, written before any run from the catalog's most common tags, 8 in each class:
  keyword, paraphrase, typo, long sentence, MCP tool (`queries.json`). Each has a `need`: what a
  correct result does.
- **Grades:** the top 20 of every method and model were pooled and graded 0–3 against the `need`
  by four LLM judges that did not know which method returned a listing; 2,497 pairs in all, 846 of
  them graded 1–3 (`grades.json`, the rest are 0). No listing in any model's top 10 is ungraded.
- **Words only:** PostgreSQL 18 full-text, `english` configuration, a weighted `tsvector` (name
  1.0, tags 0.67, description 0.5, parameters 0.33), the query's words OR-ed, ranked by
  `ts_rank_cd` (`lexical.py`).
- **Meaning only:** exact cosine between the query's vector and every listing's.
- **Fused:** Reciprocal Rank Fusion, k = 60, over each part's top 50. Equal weights lost to meaning
  alone (bge-small R@20 −0.061, 95% CI −0.109 .. −0.015); meaning weighted 3 to words 1 did not.
  The weights were picked on these 40 queries, so they are a starting point; tuning them needs more
  queries of this kind, never 0135's evaluation set.

nDCG@10 / R@20, fused 3 : 1 (`eval_ours.py`):

| Model                  | nDCG@10 | R@20  | vs bge-small, nDCG@10 (95% CI) |
| ---------------------- | ------- | ----- | ------------------------------ |
| granite-embedding-30m  | 0.706   | 0.710 | +0.006 (−0.054 .. +0.070)      |
| bge-small-en-v1.5      | 0.700   | 0.701 | —                              |
| gte-small              | 0.695   | 0.707 | −0.005 (−0.033 .. +0.022)      |
| bge-base-en-v1.5       | 0.683   | 0.722 | −0.017 (−0.048 .. +0.016)      |
| snowflake-arctic-embed-s | 0.652 | 0.700 | −0.048 (−0.088 .. −0.009)      |
| e5-small-v2            | 0.647   | 0.663 | −0.053 (−0.108 .. −0.006)      |
| all-MiniLM-L6-v2       | 0.640   | 0.691 | −0.060 (−0.115 .. −0.007)      |

By query class, nDCG@10:

| Method            | keyword | paraphrase | typo  | long  | MCP   | all   |
| ----------------- | ------- | ---------- | ----- | ----- | ----- | ----- |
| words only        | 0.639   | 0.189      | 0.288 | 0.409 | 0.655 | 0.436 |
| granite only      | 0.665   | 0.711      | 0.653 | 0.798 | 0.746 | 0.715 |
| granite fused 3:1 | 0.723   | 0.669      | 0.672 | 0.710 | 0.755 | 0.706 |

Words alone miss paraphrases and typos. Fused minus granite alone, with paired 95% intervals over
8 queries a class: keyword +0.058 (+0.014 .. +0.127), long −0.088 (−0.124 .. −0.056), paraphrase
−0.042, typo +0.019 and MCP +0.009, the last three within noise; all 40 queries −0.009 (−0.037 ..
+0.019). Relevant, for R@20, means a grade of 2 or 3.

## ToolRet

ToolRet (`mangopy/ToolRet-Queries`, `mangopy/ToolRet-Tools`, MTEB task `ToolRetrieval`): 7,961
queries over 44,453 tool descriptions. Each query searches its own category's tools (web 37,292,
code 3,794, customized 3,367) by exact cosine, inputs cut to 256 tokens, query only, no instruction
(`toolret_run.py`, `toolret_compare.py`). The paper pools all tools into one corpus, so these
numbers are not comparable with its table; the order between models holds within this setup.

| Model                  | nDCG@10 | R@20  | vs bge-small, nDCG@10 (95% CI) | Subsets won of 35 |
| ---------------------- | ------- | ----- | ------------------------------ | ----------------- |
| bge-base-en-v1.5       | 34.38   | 50.97 | +2.18 (+1.71 .. +2.65)         | 12                |
| granite-embedding-30m  | 32.75   | 49.02 | +0.55 (−0.01 .. +1.09)         | 5                 |
| bge-small-en-v1.5      | 32.20   | 48.14 | —                              | 4                 |
| e5-small-v2            | 31.60   | 46.66 | −0.61 (−1.18 .. −0.04)         | 6                 |
| gte-small              | 30.24   | 45.57 | −1.97 (−2.41 .. −1.55)         | 4                 |
| snowflake-arctic-embed-s | 28.71 | 42.91 | −3.49 (−4.04 .. −2.95)         | 2                 |
| all-MiniLM-L6-v2       | 26.23   | 41.24 | −5.97 (−6.53 .. −5.41)         | 2                 |

granite's R@20 is ahead of bge-small's: +0.88 (+0.13 .. +1.56). On our test bge-base against
granite is −0.023 nDCG@10 and +0.013 R@20 (−0.052 .. +0.078).

## Cost

`serve_mem.py`, one process holding one model, embedding listings one at a time:

| Model                  | Parameters | Dimensions | Per listing, ms | Per query p50, ms | Peak RSS, MB | Licence    |
| ---------------------- | ---------- | ---------- | --------------- | ----------------- | ------------ | ---------- |
| all-MiniLM-L6-v2       | 23M        | 384        | 8.7             | 1.4               | 252          | Apache-2.0 |
| granite-embedding-30m  | 30M        | 384        | 8.4             | 1.5               | 371          | Apache-2.0 |
| bge-small-en-v1.5      | 33M        | 384        | 17.4            | 3.3               | 306          | MIT        |
| gte-small              | 33M        | 384        | 17.1            | 2.7               | 314          | MIT        |
| snowflake-arctic-embed-s | 33M      | 384        | 16.7            | 3.4               | 305          | Apache-2.0 |
| e5-small-v2            | 33M        | 384        | 17.0            | 2.9               | 309          | MIT        |
| bge-base-en-v1.5       | 110M       | 768        | 43.0            | 9.9               | 710          | MIT        |

An exact cosine scan of 3,000 vectors of 384 dimensions takes 0.18 ms (NumPy, M4). pgvector's
scan inside PostgreSQL was not measured.

## Running it

The scripts are the record of how the numbers were made, not a one-command run. Each takes one
base directory with this layout:

- `scripts/`: the files in `benchmark/` (the others import `embed.py` from there);
- `data/`: `queries.json` and `grades.json` from `benchmark/`, and `listings.jsonl`, which
  `build_corpus.py` builds from two JSON-lines downloads of CDP's `/discovery/resources`
  (`stellar.jsonl`, the Stellar pubnet entries, and `cdp.jsonl`, all of them). The downloads are
  not committed;
- `models/<name>/onnx/model.onnx` with its tokenizer, from each model's Hugging Face repository;
- `toolret/`: the two ToolRet parquet sets.

`lexical.py` runs against a local PostgreSQL 18 container; its docstring holds the table it reads.
`eval_ours.py` counts a listing as graded when a judge was shown it; the judges' input files are
not committed, so its share of ungraded listings needs them. `embed.py` lists each model's pooling,
length and query prefix.
