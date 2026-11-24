"""Compare models on ToolRet: means, paired bootstrap 95% intervals, and per-subset wins."""
import json, random, sys, collections
B = sys.argv[1]
R = {n: {r["id"]: r for r in json.load(open(f"{B}/data/toolret_{n}.json"))} for n in ["minilm", "bge", "gte", "arctic", "e5", "granite", "bgebase"]}
ids = sorted(R["minilm"])
mean = lambda x: sum(x) / len(x)
for cat in ["all", "web", "code", "customized"]:
    sel = [i for i in ids if cat == "all" or R["minilm"][i]["category"] == cat]
    print(f"{cat:10} n={len(sel):5} " + "  ".join(f"{n}: {mean([R[n][i]['ndcg10'] for i in sel])*100:5.2f}/{mean([R[n][i]['recall20'] for i in sel])*100:5.2f}" for n in R))
random.seed(3)
def boot(a, b, met, sel):
    d = [R[a][i][met] - R[b][i][met] for i in sel]
    s = sorted(mean(random.choices(d, k=len(d))) for _ in range(2000))
    return mean(d) * 100, s[50] * 100, s[1949] * 100
print("\npaired, all queries, points (95% CI):")
for a, b in [(m, "bge") for m in ["minilm", "gte", "arctic", "e5", "granite", "bgebase"]]:
    for met in ["ndcg10", "recall20"]:
        mu, lo, hi = boot(a, b, met, ids)
        print(f"{a}-{b} {met}: {mu:+.2f} ({lo:+.2f} .. {hi:+.2f})")
by = collections.defaultdict(list)
for i in ids: by[R["minilm"][i]["subset"]].append(i)
wins = collections.Counter()
for s, sel in by.items():
    best = max(R, key=lambda n: mean([R[n][i]["ndcg10"] for i in sel])); wins[best] += 1
print("\nsubsets won (of", len(by), "):", dict(wins))
