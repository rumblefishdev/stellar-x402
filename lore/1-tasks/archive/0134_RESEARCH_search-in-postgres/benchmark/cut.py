"""Cutting each part before fusion at 20, 50, 100 or not at all, with matches by meaning
(cosine >= 0.60). Reads the same container as lexical.py."""
import json, math, sys, glob, subprocess
import numpy as np
B = sys.argv[1]
sys.path.insert(0, B + "/scripts"); from embed import Model
qs = json.load(open(f"{B}/data/queries.json")); G = json.load(open(f"{B}/data/grades.json"))
for f in sorted(glob.glob(f"{B}/data/grades_new_*.json")):
    for q, gr in json.load(open(f)).items(): G.setdefault(q, {}).update(gr)
L = [json.loads(l) for l in open(f"{B}/data/listings.jsonl")]
stellar = np.array([x["stellar"] for x in L])
def g(q, d): return G.get(q, {}).get(str(d), 0)
def ndcg(q, rk):
    dcg = sum(g(q, d) / math.log2(i + 2) for i, d in enumerate(rk[:10]))
    return dcg / sum(v / math.log2(i + 2) for i, v in enumerate(sorted(G[q].values(), reverse=True)[:10]))
def rec20(q, rk):
    rel = {d for d, v in G[q].items() if v >= 2}; return len(rel & {str(d) for d in rk[:20]}) / len(rel)
def setrec(q, S_, t=2):
    rel = {int(d) for d, v in G[q].items() if v >= t}; return len(rel & S_) / len(rel) if rel else None
def lex(text, weights=None):
    lit = text.replace("'", "''")
    tq = f"replace(plainto_tsquery('english', '{lit}')::text, '&', '|')"
    if weights:
        r0 = subprocess.run(["docker", "exec", "-i", "bench-pg-0134", "psql", "-U", "postgres", "-tA", "-c", f"SELECT plainto_tsquery('english', '{lit}')::text"], capture_output=True, text=True).stdout.strip()
        lx = [t.strip().strip("'") for t in r0.split("&") if t.strip()]
        if not lx: return []
        tq = "'" + " | ".join(f"''{x}'':{weights}" for x in lx) + "'"
    sql = f"""SELECT coalesce(json_agg(id ORDER BY r DESC, id), '[]') FROM (
      SELECT id, ts_rank_cd('{{0.33,0.5,0.67,1.0}}', tsv, query) AS r
      FROM listing, CAST({tq} AS tsquery) AS query WHERE tsv @@ query) t;"""
    res = subprocess.run(["docker", "exec", "-i", "bench-pg-0134", "psql", "-U", "postgres", "-tA", "-c", sql], capture_output=True, text=True)
    if res.returncode: print(res.stderr[:300]); return []
    return json.loads(res.stdout.strip() or "[]")
def fuse(mr, wr, k=20, w=4):
    s = {}
    for wt, rk in ((w, mr), (1, wr)):
        for i, d in enumerate(rk): s[d] = s.get(d, 0) + wt / (k + i + 1)
    return [d for d, _ in sorted(s.items(), key=lambda x: (-x[1], x[0]))]
WALL = {q["id"]: lex(q["query"]) for q in qs}
WAB = {q["id"]: lex(q["query"], "AB") for q in qs}
testnet = "weather. Current temperature for a city. Inputs: city"
tq = ["weather in warsaw", "current temperature in a city", "what is the temperature in berlin right now", "is it raining", "btc price feed", "translate text to german", "check if an IBAN is valid", "scrape a web page to markdown"]
vecs = np.load(f"{B}/data/vec_granite.npy"); m = Model(B, "granite")
for scope in ("all",):
    res = {}; over = 0; sizes = []
    for q in qs:
        s_ = vecs @ m.embed([q["query"]], query=True)[0]
        order = [int(d) for d in np.argsort(-s_) if s_[d] >= 0.60 and (scope == "all" or stellar[d])]
        Ms = set(order); W = [d for d in WALL[q["id"]] if d in Ms]
        sizes.append(len(order)); over += len(order) > 50
        for cut in (20, 50, 100, None):
            mr = order if cut is None else order[:cut]; wr = W if cut is None else W[:cut]
            rk = fuse(mr, wr); r = res.setdefault(cut, ([], []))
            r[0].append(ndcg(q["id"], rk)); r[1].append(rec20(q["id"], rk))
    sizes.sort()
    print(scope, "matches p50", sizes[20], "p90", sizes[36], "max", sizes[-1], "| >50 in", over, "of 40")
    for cut, (n, r) in res.items(): print(f"  cut {cut}: nDCG@10 {sum(n)/len(n):.3f}  R@20 {sum(r)/len(r):.3f}")
