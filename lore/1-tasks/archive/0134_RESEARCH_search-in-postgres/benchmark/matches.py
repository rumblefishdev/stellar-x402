"""What counts as a match: four rules, each scored by set size, relevant listings kept and
fused nDCG@10 / R@20 (granite, k = 20, meaning weighted 4, every match ranked). Reads the
same container as lexical.py, and prints the testnet listing's similarity to a few queries."""
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
for name, floor in (("granite", 0.60),):
    vecs = np.load(f"{B}/data/vec_{name}.npy"); m = Model(B, name)
    sims = {q["id"]: vecs @ m.embed([q["query"]], query=True)[0] for q in qs}
    rel = np.array([sims[q["id"]][int(d)] for q in qs for d, v in G[q["id"]].items() if v >= 2])
    non = np.array([sims[q["id"]][int(d)] for q in qs for d, v in G[q["id"]].items() if v == 0])
    if floor is None: floor = float(np.percentile(rel, 2))
    print(f"\n== {name}: relevant p2 {np.percentile(rel,2):.3f} p5 {np.percentile(rel,5):.3f} p50 {np.median(rel):.3f} | judged-0 p50 {np.median(non):.3f} | floor used {floor:.3f} keeps {np.mean(rel>=floor):.0%} rel, {np.mean(non>=floor):.0%} judged-0")
    tv = m.embed([testnet])[0]; qv = m.embed(tq, query=True)
    print("  testnet listing:", {t: round(float(v @ tv), 3) for t, v in zip(tq, qv)})
    # fusion grid, all matches (no cut)
    grid = {}
    for k in (10, 20, 30, 60):
        for w in (1, 2, 3, 4, 6):
            nd = [ndcg(q["id"], fuse([int(d) for d in np.argsort(-sims[q["id"]]) if sims[q["id"]][d] >= floor], WALL[q["id"]], k, w)) for q in qs]
            grid[(k, w)] = sum(nd) / len(nd)
    best = max(grid, key=grid.get)
    print("  grid best", best, round(grid[best], 3), "| k20w4", round(grid[(20, 4)], 3), "| k60w3", round(grid[(60, 3)], 3), "| meaning only", round(sum(ndcg(q['id'], list(np.argsort(-sims[q['id']]))) for q in qs) / len(qs), 3))
    defs = {}
    for q in qs:
        s = sims[q["id"]]; order = [int(d) for d in np.argsort(-s)]
        M = [d for d in order if s[d] >= floor]
        cliff = [d for d in order if s[d] >= max(floor, s[order[0]] - 0.10)]
        sets = {"D1 any word ∪ meaning": (M, WALL[q["id"]]),
                "D2 meaning only": (M, [d for d in WALL[q["id"]] if d in set(M)]),
                "D3 meaning ∪ word in name/tags": (M, WAB[q["id"]]),
                "D4 meaning within 0.10 of best": (cliff, [d for d in WALL[q["id"]] if d in set(cliff)])}
        for dn, (mr, wr) in sets.items():
            U = set(mr) | set(wr); rk = fuse(mr, wr)
            r = defs.setdefault(dn, {"n": [], "ns": [], "sr2": [], "sr3": [], "nd": [], "r20": []})
            r["n"].append(len(U)); r["ns"].append(sum(1 for d in U if stellar[d]))
            for t, key in ((2, "sr2"), (3, "sr3")):
                v = setrec(q["id"], U, t)
                if v is not None: r[key].append(v)
            r["nd"].append(ndcg(q["id"], rk)); r["r20"].append(rec20(q["id"], rk))
    for dn, r in defs.items():
        n = sorted(r["n"]); ns = sorted(r["ns"]); mean = lambda x: sum(x) / len(x)
        print(f"  {dn:34s} size p50 {n[20]:5d} p90 {n[36]:5d} | Stellar p50 {ns[20]:4d} | >20: {sum(x>20 for x in n):2d}/40 | keeps rel≥2 {mean(r['sr2']):.0%} rel=3 {mean(r['sr3']):.0%} | nDCG@10 {mean(r['nd']):.3f} R@20 {mean(r['r20']):.3f}")
