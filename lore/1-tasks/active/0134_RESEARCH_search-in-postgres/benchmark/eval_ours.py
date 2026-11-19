"""Our 3,000-listing test for any set of models: meaning only and RRF with meaning weighted 3 : 1.
Listings a model ranks that no judge saw count as 0; their share in the top 10 is reported."""
import json, math, sys, time
import numpy as np
sys.path.insert(0, sys.argv[1] + "/scripts")
from embed import Model
B = sys.argv[1]; names = sys.argv[2].split(",")
import glob
qs = json.load(open(f"{B}/data/queries.json")); G = json.load(open(f"{B}/data/grades.json"))
for f in sorted(glob.glob(f"{B}/data/grades_new_*.json")):
    for q, gr in json.load(open(f)).items(): G.setdefault(q, {}).update(gr)
lex = json.load(open(f"{B}/data/run_lexical.json"))
# a listing counts as judged when it was shown to a judge, whatever grade it got
judged = {}
for f in glob.glob(f"{B}/data/judge_*.json"):
    for q in json.load(open(f)): judged.setdefault(q["id"], set()).update(c["lid"] for c in q["candidates"])
pool = judged
def g(q, d): return G.get(q, {}).get(str(d), 0)
def ndcg(q, rk):
    dcg = sum(g(q, d) / math.log2(i + 2) for i, d in enumerate(rk[:10]))
    return dcg / sum(v / math.log2(i + 2) for i, v in enumerate(sorted(G[q].values(), reverse=True)[:10]))
def rec(q, rk):
    rel = {d for d, v in G[q].items() if v >= 2}; return len(rel & {str(d) for d in rk[:20]}) / len(rel)
mean = lambda x: sum(x) / len(x)
out = {}
for name in names:
    vecs = np.load(f"{B}/data/vec_{name}.npy"); m = Model(B, name); m.embed(["warm"], query=True)
    dense, hyb, lat = {}, {}, []
    for q in qs:
        t0 = time.perf_counter(); qv = m.embed([q["query"]], query=True)[0]; lat.append((time.perf_counter() - t0) * 1000)
        top = np.argsort(-(vecs @ qv))[:50].tolist(); dense[q["id"]] = top
        s = {}
        for w, rk in ((3, top), (1, lex[q["id"]])):
            for i, d in enumerate(rk): s[d] = s.get(d, 0) + w / (60 + i + 1)
        hyb[q["id"]] = [d for d, _ in sorted(s.items(), key=lambda x: (-x[1], x[0]))][:50]
    json.dump(hyb, open(f"{B}/data/run_h3_{name}.json", "w"))
    lat.sort()
    out[name] = {"dense_ndcg10": mean([ndcg(q["id"], dense[q["id"]]) for q in qs]),
                 "h3_ndcg10": mean([ndcg(q["id"], hyb[q["id"]]) for q in qs]),
                 "h3_recall20": mean([rec(q["id"], hyb[q["id"]]) for q in qs]),
                 "unjudged_top10": mean([sum(1 for d in hyb[q["id"]][:10] if d not in judged[q["id"]]) / 10 for q in qs]),
                 "dense_recall20": mean([rec(q["id"], dense[q["id"]]) for q in qs]),
                 "query_ms_p50": lat[len(lat) // 2]}
    print(name, {k: round(v, 3) for k, v in out[name].items()}, flush=True)
json.dump(out, open(f"{B}/data/ours_{'_'.join(names)}.json", "w"))
