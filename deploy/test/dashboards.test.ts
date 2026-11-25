// The Grafana dashboards the monitoring VM loads from this repo at a pinned commit (lore 0139). A
// metric renamed in the catalog would leave a panel empty with nothing to say so.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CATALOG } from "@stellar-x402/metrics-catalog";
import { expect, test } from "vitest";

const DIR = fileURLToPath(new URL("../metrics/dashboards", import.meta.url));
const dashboards = readdirSync(DIR).map((f) => ({
  file: f,
  json: JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) as {
    uid: string;
    panels: { targets?: { expr: string; datasource: { uid: string } }[] }[];
    templating?: { list: { definition?: string }[] };
  },
}));
// Series that aren't the catalog's: node_exporter's, the agent's own, and the liveness series.
const OTHER = /^(node_|prometheus_remote_storage_|up$|facilitator_started_timestamp_seconds$)/;
const KNOWN = new Set(CATALOG.map((m) => m.name));

test.each(dashboards)(
  "$file reads only series that exist, from the provisioned datasource",
  ({ json }) => {
    expect(json.uid).toMatch(/^x402-/);
    const targets = json.panels.flatMap((p) => p.targets ?? []);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t.datasource.uid).toBe("prometheus");
    // The panels' queries and the variables' (a variable's metric renamed empties its menu).
    const queries = [
      ...targets.map((t) => t.expr),
      ...(json.templating?.list ?? []).flatMap((v) => v.definition ?? []),
    ];
    for (const q of queries)
      for (const [, name] of q.matchAll(/([a-zA-Z_:][a-zA-Z0-9_:]*)\{/g))
        if (!OTHER.test(name!)) expect(KNOWN, `${name} in ${q}`).toContain(name);
  },
);
