"""ToolRet, query-only setting: each query searches its category's tool corpus by exact cosine.
Writes per-query nDCG@10 (gain = label relevance) and Recall@20 for one model."""
import glob, json, math, sys, time
import numpy as np, pyarrow.parquet as pq
sys.path.insert(0, sys.argv[1] + "/scripts")
import embed
base, name, threads = sys.argv[1], sys.argv[2], int(sys.argv[3])
embed.MODELS[name]["max"] = 256
m = embed.Model(base, name)
import onnxruntime as ort
so = ort.SessionOptions(); so.intra_op_num_threads = threads
m.sess = ort.InferenceSession(f"{base}/models/{embed.MODELS[name]['dir']}/onnx/model.onnx", so)

def encode(texts, query):
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    out = None
    for s in range(0, len(order), 64):
        idx = order[s:s+64]
        v = m.embed([texts[i] for i in idx], query=query)
        if out is None:
            out = np.zeros((len(texts), v.shape[1]), dtype=np.float32)
        out[idx] = v
    return out

results, t0 = [], time.time()
for cat in ["web", "code", "customized"]:
    tools = pq.read_table(glob.glob(f"{base}/toolret/ToolRet-Tools/{cat}/*.parquet")[0]).to_pylist()
    ids = [t["id"] for t in tools]
    dv = encode([t["documentation"] for t in tools], False)
    qs = [r for f in sorted(glob.glob(f"{base}/toolret/ToolRet-Queries/*/*.parquet"))
          for r in pq.read_table(f).to_pylist() if r["category"] == cat]
    qv = encode([q["query"] for q in qs], True)
    top = np.argsort(-(qv @ dv.T), axis=1)[:, :20]
    for q, row in zip(qs, top):
        rel = {l["id"]: max(int(l["relevance"]), 1) for l in json.loads(q["labels"])}
        ranked = [ids[j] for j in row]
        dcg = sum(rel.get(d, 0) / math.log2(i + 2) for i, d in enumerate(ranked[:10]))
        idcg = sum(v / math.log2(i + 2) for i, v in enumerate(sorted(rel.values(), reverse=True)[:10]))
        results.append({"id": q["id"], "subset": q["id"].rsplit("_query_", 1)[0], "category": cat,
                        "ndcg10": dcg / idcg, "recall20": len(set(ranked) & set(rel)) / len(rel)})
    print(cat, len(qs), "queries", len(tools), "tools", round(time.time() - t0), "s", flush=True)
json.dump(results, open(f"{base}/data/toolret_{name}.json", "w"))
print(name, "nDCG@10", round(sum(r["ndcg10"] for r in results) / len(results) * 100, 2),
      "R@20", round(sum(r["recall20"] for r in results) / len(results) * 100, 2), "time", round(time.time() - t0), "s")
