"""Words-only ranking in PostgreSQL 18: weighted tsvector (name A=1.0, tags B=0.67,
description C=0.5, params D=0.33, the ratios 3:2:1.5:1), query words OR-ed so a long
sentence still matches, ranked by ts_rank_cd.

It reads a container named bench-pg-0134 (postgres:18) holding listings.jsonl as `raw(doc jsonb)` and:
  CREATE TABLE listing AS
  SELECT (doc->>'id')::int AS id,
         setweight(to_tsvector('english', coalesce(doc->>'name','')), 'A') ||
         setweight(to_tsvector('english', coalesce(doc->>'tags','')), 'B') ||
         setweight(to_tsvector('english', coalesce(doc->>'description','')), 'C') ||
         setweight(to_tsvector('english', coalesce(doc->>'params','')), 'D') AS tsv
  FROM raw;
  CREATE INDEX ON listing USING gin (tsv);"""
import json, subprocess, sys, time
base = sys.argv[1]
qs = json.load(open(f"{base}/data/queries.json"))
out, times = {}, []
for q in qs:
    lit = q["query"].replace("'", "''")
    sql = f"""SELECT coalesce(json_agg(id ORDER BY r DESC, id), '[]') FROM (
      SELECT id, ts_rank_cd('{{0.33,0.5,0.67,1.0}}', tsv, query) AS r
      FROM listing, CAST(replace(plainto_tsquery('english', '{lit}')::text, '&', '|') AS tsquery) AS query
      WHERE tsv @@ query ORDER BY r DESC, id LIMIT 50) t;"""
    t0 = time.time()
    res = subprocess.run(["docker", "exec", "-i", "bench-pg-0134", "psql", "-U", "postgres", "-tA", "-c", sql],
                         capture_output=True, text=True, check=True)
    times.append(time.time() - t0)
    out[q["id"]] = json.loads(res.stdout.strip() or "[]")
json.dump(out, open(f"{base}/data/run_lexical.json", "w"))
print({"queries": len(out), "empty": sum(1 for v in out.values() if not v)})
