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
  by LLM judges that did not know which method returned a listing, in two rounds: the first round
  for words only and three models, the second, by other judges, for the pairs the four later
  models added. 2,497 pairs in all, 846 of them graded 1–3 (`grades.json`, the rest are 0). No
  listing in any run's top 20 is ungraded.
  - Round-two grades give at most 4.3% of any model's top-10 gain; scoring them all 0 puts
    bge-small fused (0.714) above granite (0.706), so the two are tied on this test.
  - Three grades name listings the judge was not shown (q34/1135, q12/493) or overwrite a first
    round grade (q12/1493, q32/2875); their effect on nDCG@10 is at most 0.001. A rerun should
    refuse a grade for a listing the judge was not shown.
  - The corpus is all Stellar pubnet listings plus others; a pubnet search sees only the 1,637
    Stellar ones, where 36% come from one host. The grid below gives both.
- **Words only:** PostgreSQL 18 full-text, `english` configuration, a weighted `tsvector` (name
  1.0, tags 0.67, description 0.5, parameters 0.33), the query's words OR-ed, ranked by
  `ts_rank_cd` (`lexical.py`).
- **Meaning only:** exact cosine between the query's vector and every listing's.
- **Fused:** Reciprocal Rank Fusion over each part's top 50. The tables below use meaning weighted
  3 to words 1, k = 60, the first point tried. A grid for granite (nDCG@10, all 3,000 listings /
  the 1,637 Stellar ones alone):

  | k   | w = 1         | w = 2         | w = 3         | w = 4         | w = 6         |
  | --- | ------------- | ------------- | ------------- | ------------- | ------------- |
  | 10  | 0.665 / 0.667 | 0.720 / 0.715 | 0.721 / 0.722 | 0.723 / 0.722 | 0.723 / 0.721 |
  | 20  | 0.662 / 0.660 | 0.719 / 0.703 | 0.723 / 0.718 | 0.726 / 0.722 | 0.723 / 0.723 |
  | 30  | 0.652 / 0.654 | 0.713 / 0.697 | 0.720 / 0.711 | 0.723 / 0.717 | 0.726 / 0.722 |
  | 60  | 0.643 / 0.651 | 0.689 / 0.677 | 0.706 / 0.695 | 0.716 / 0.700 | 0.723 / 0.708 |

  Meaning alone scores 0.715 / 0.713. ADR 0014 takes k = 20, w = 4: +0.012 nDCG@10 (95% CI
  −0.005 .. +0.030) and +0.014 R@20 (−0.005 .. +0.035) over meaning alone. Equal weights at k = 60
  lose: −0.072 nDCG@10 (−0.125 .. −0.016). Choosing w on 20 queries and scoring the other 20 gains
  +0.006 over meaning alone, so the grid is flat, not tuned. Tuning needs more queries of this
  kind, never 0135's evaluation set.

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

Words alone miss paraphrases and typos: 2 typo queries get nothing, and 9 of 40 have no relevant
listing in the top 10. Fused (3 : 1, k = 60) minus granite alone: all 8 long queries lose, −0.088
(exact sign-flip p = 0.008, 0.039 after a Holm correction for 5 classes); the keyword gain, +0.058,
rests on one query (q01, +0.287; the other 7 average +0.025) and does not survive the correction;
paraphrase, typo and MCP are within noise. Relevant, for R@20, means a grade of 2 or 3.

## Matches and the cut

Measured after the ADR's first draft, with granite, k = 20, meaning weighted 4, every match
ranked (`matches.py`, `cut.py`). What counts as a match (median matches per query, with the
Stellar listings alone in brackets):

| A listing matches when                        | Matches   | Relevant kept (grade ≥ 2 / 3) | nDCG@10 | R@20  |
| --------------------------------------------- | --------- | ----------------------------- | ------- | ----- |
| it holds any query word, or cosine ≥ 0.60      | 556 (322) | 99% / 99%                     | 0.725   | 0.723 |
| cosine ≥ 0.60 (the ADR's rule)                 | 158 (76)  | 97% / 99%                     | 0.724   | 0.721 |
| a query word is in its name or tags, or ≥ 0.60 | 245 (105) | 98% / 99%                     | 0.709   | 0.711 |
| cosine within 0.10 of the best match           | 24 (12)   | 74% / 83%                     | 0.698   | 0.635 |

OR-ed words match almost everything: "api to check if an IBAN number is valid" holds a word of
2,232 of the 3,000 listings. With matches by meaning, cutting each part before fusion:

| Cut        | nDCG@10 | R@20  |
| ---------- | ------- | ----- |
| 20         | 0.713   | 0.707 |
| 50         | 0.725   | 0.716 |
| 100        | 0.726   | 0.717 |
| none (ADR) | 0.724   | 0.721 |

Matches per query: median 158, 90th percentile 544, at most 744; 36 of 40 queries have more
than 50 (27 of 40 among the Stellar listings alone).

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

granite's R@20 is ahead of bge-small's: +0.88 (+0.13 .. +1.56) averaged per query; averaged per
subset bge-small leads, 27.93 to 27.11 nDCG@10, so the two are tied. The 256-token cut truncates
17.9% of tool texts with granite's tokenizer and 24.8% with bge's, which may favour granite. On our
test bge-base against granite is −0.023 nDCG@10 and +0.013 R@20 (−0.052 .. +0.078); an interval
that wide could not show a gain of ToolRet's size.

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

`lexical.py`, `matches.py` and `cut.py` run against a local PostgreSQL 18 container; `lexical.py`'s
docstring holds the table they read.
`eval_ours.py` counts a listing as graded when a judge was shown it; the judges' input files are
not committed, so its share of ungraded listings needs them. `embed.py` lists each model's pooling,
length and query prefix.
