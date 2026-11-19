"""Peak memory of one model serving the way the container would: load, then one query or one
listing at a time (batch 1). ru_maxrss is in bytes on macOS."""
import json, resource, sys, time
sys.path.insert(0, sys.argv[1] + "/scripts")
from embed import Model
base, name = sys.argv[1], sys.argv[2]
before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
m = Model(base, name)
loaded = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
rows = [json.loads(l) for l in open(f"{base}/data/listings.jsonl")][:200]
t0 = time.time()
for r in rows:
    m.embed([r["text"]])
per = (time.time() - t0) / len(rows) * 1000
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
print(json.dumps({"model": name, "python_mb": round(before/1e6), "after_load_mb": round(loaded/1e6),
                  "peak_batch1_mb": round(peak/1e6), "listing_ms_batch1": round(per, 1)}))
