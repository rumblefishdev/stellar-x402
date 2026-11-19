"""Build the 3,000-listing corpus: every Stellar listing plus a seeded sample of others.
Each listing gets weighted fields (name, tags, description, params) and one embedding text."""
import json, random, re, sys
from collections import Counter
from urllib.parse import urlparse

corpus_dir, out_dir = sys.argv[1], sys.argv[2]
stellar = [json.loads(l) for l in open(f"{corpus_dir}/stellar.jsonl")]
stellar_urls = {s["resource"] for s in stellar}
others = [json.loads(l) for l in open(f"{corpus_dir}/cdp.jsonl")]
others = [o for o in others if o["resource"] not in stellar_urls]
random.seed(402)
sample = random.sample(others, 3000 - len(stellar))

def words(s):
    return " ".join(w for w in re.split(r"[^A-Za-z0-9]+", s or "") if w)

def params(info, schema):
    out = []
    inp = info.get("input") or {}
    for key in ("queryParams", "body"):
        v = inp.get(key)
        if isinstance(v, dict):
            out += list(v.keys())
    props = (info.get("inputSchema") or {}).get("properties") or {}
    for k, v in props.items():
        out.append(k)
        if isinstance(v, dict) and isinstance(v.get("description"), str):
            out.append(v["description"])
    sp = (((schema or {}).get("properties") or {}).get("input") or {}).get("properties") or {}
    for key in ("queryParams", "body"):
        for k, v in ((sp.get(key) or {}).get("properties") or {}).items():
            out.append(k)
            if isinstance(v, dict) and isinstance(v.get("description"), str):
                out.append(v["description"])
    return [p[:300] for p in out][:40]

rows = []
for i, item in enumerate(stellar + sample):
    baz = (item.get("extensions") or {}).get("bazaar") or {}
    info = baz.get("info") or {}
    tool = (info.get("mcp") or {}).get("toolName") or ""
    path = words(urlparse(item["resource"]).path)
    name = " ".join(x for x in [item.get("serviceName") or "", tool.replace("_", " "), path] if x)
    tags = " ".join(item.get("tags") or [])
    desc = " ".join(x for x in [item.get("description") or "", (info.get("inputSchema") or {}).get("description") or ""] if x)
    prm = " ".join(params(info, baz.get("schema")))
    emb = ". ".join(x for x in [name, desc, f"Tags: {tags}" if tags else "", f"Inputs: {prm}" if prm else ""] if x)
    rows.append({"id": i, "resource": item["resource"], "type": item.get("type"),
                 "stellar": item["resource"] in stellar_urls,
                 "host": urlparse(item["resource"]).hostname,
                 "name": name, "tags": tags, "description": desc, "params": prm, "text": emb[:2000]})
with open(f"{out_dir}/listings.jsonl", "w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
tag_counts = Counter(t.lower() for item in stellar + sample for t in (item.get("tags") or []))
json.dump(tag_counts.most_common(80), open(f"{out_dir}/top_tags.json", "w"))
print(len(rows), sum(r["stellar"] for r in rows), sum(r["type"] == "mcp" for r in rows))
