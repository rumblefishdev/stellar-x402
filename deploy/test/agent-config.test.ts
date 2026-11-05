// The CloudWatch agent's config against the files table (AD-2, AD-3), the metric catalog (AD-4)
// and the credentials chain (AD-8) of lore 0027's server-side spine. The agent's JSON schema
// takes no comments, so what each setting is for is said here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { byName, CATALOG, EMF_LINE_PREFIX, effectiveSets } from "@stellar-x402/metrics-catalog";
import { describe, expect, test } from "vitest";
import { absolute, FILES, GROUPS } from "./files.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

interface Entry {
  file_path: string;
  log_group_name: string;
  log_stream_name: string;
  multi_line_start_pattern?: string;
  filters?: { type: string; expression: string }[];
  [key: string]: unknown;
}
interface AgentConfig {
  agent: Record<string, unknown>;
  logs: { logs_collected: { files: { collect_list: Entry[] } }; [key: string]: unknown };
  metrics: {
    namespace: string;
    aggregation_dimensions?: string[][];
    metrics_collected: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
}

const RAW = read("../cloudwatch-agent/config.json");
const CONFIG = JSON.parse(RAW) as AgentConfig;
const ENTRIES = CONFIG.logs.logs_collected.files.collect_list;

/** `^` and the prefix with RE2's metacharacters escaped, built from the catalog's constant. */
const EMF_FILTER = `^${EMF_LINE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;

/** The agent names an entry's saved offset after its path, with these replaced by `_`. */
const stateName = (path: string) => path.replace(/[/ :]/g, "_");

describe("the agent's logs", () => {
  test("lists exactly the files table, each once", () => {
    expect(ENTRIES.map((e) => e.file_path).sort()).toEqual(FILES.map(absolute).sort());
  });

  test("sends each file to its group and stream, the groups being decision 24's two", () => {
    for (const row of FILES) {
      const e = ENTRIES.find((x) => x.file_path === absolute(row));
      expect(e?.log_group_name, row.path).toBe(GROUPS[row.group]);
      expect(e?.log_stream_name, row.path).toBe(row.stream);
    }
    for (const e of ENTRIES) expect(Object.values(GROUPS), e.file_path).toContain(e.log_group_name);
  });

  test("an EMF row goes to the metrics group only", () => {
    for (const row of FILES)
      if (row.filter === "include-emf") expect(row.group, row.path).toBe("metrics");
      else expect(row.group, row.path).toBe("app");
  });

  test("no group and stream pair repeats, and no two paths share a saved offset", () => {
    const pairs = ENTRIES.map((e) => `${e.log_group_name} ${e.log_stream_name}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    const states = ENTRIES.map((e) => stateName(e.file_path));
    expect(new Set(states).size).toBe(states.length);
  });

  test("splits on the catalog's EMF prefix, and only where the table says", () => {
    for (const row of FILES) {
      const e = ENTRIES.find((x) => x.file_path === absolute(row));
      const expected =
        row.filter === undefined
          ? undefined
          : [
              {
                type: row.filter === "include-emf" ? "include" : "exclude",
                expression: EMF_FILTER,
              },
            ];
      expect(e?.filters, row.path).toEqual(expected);
    }
  });

  test("the filter keeps an EMF line and nothing else", () => {
    const filter = new RegExp(EMF_FILTER);
    expect(
      filter.test(
        '{"_aws":{"Timestamp":1,"CloudWatchMetrics":[{"Namespace":"x402-host","Dimensions":[[]],"Metrics":[{"Name":"host_probe_heartbeat","Unit":"None"}]}]},"host_probe_heartbeat":1}',
      ),
    ).toBe(true);
    expect(filter.test('{"time":"2026-11-05T12:00:00.000Z","level":"info","event":"x"}')).toBe(
      false,
    );
    expect(filter.test("\r\x1b[Kfacilitator-1 exited with code 1")).toBe(false);
    expect(filter.test(' {"_aws":{}}')).toBe(false);
  });

  // The default `^[\S]` joins a line that starts with whitespace to the one before: Compose's
  // `\r\x1b[K... exited` line would join the last EMF line and break its JSON (the spike).
  test("every line starts an event on a file that carries EMF, the default elsewhere", () => {
    for (const row of FILES) {
      const e = ENTRIES.find((x) => x.file_path === absolute(row));
      expect(e?.multi_line_start_pattern, row.path).toBe(row.emf ? "^" : undefined);
    }
  });

  test("sets nothing the role can't do or the spine rules out", () => {
    for (const e of ENTRIES)
      for (const key of [
        "timestamp_format",
        "retention_in_days",
        "log_group_class",
        "auto_removal",
        "encoding",
      ])
        expect(e, `${e.file_path}: ${key}`).not.toHaveProperty(key);
    expect(Object.keys(CONFIG.logs).sort()).toEqual(["force_flush_interval", "logs_collected"]);
  });
});

describe("the agent's metrics", () => {
  const disk = byName("disk_used_percent");
  const plugins = CONFIG.metrics.metrics_collected;

  test("go to the catalog's host namespace, never CWAgent", () => {
    expect(disk?.namespace).toBe("x402-host");
    expect(CONFIG.metrics.namespace).toBe(disk?.namespace);
  });

  test("are exactly memory and disk use, as the catalog names them, and no CPU", () => {
    const written = Object.entries(plugins).flatMap(([plugin, cfg]) =>
      (cfg["measurement"] as string[]).map((m) => `${plugin}_${m}`),
    );
    expect(written.sort()).toEqual(["disk_used_percent", "mem_used_percent"]);
    for (const name of written) {
      const def = CATALOG.find((m) => m.name === name);
      expect(def?.namespace, name).toBe("x402-host");
      expect(def?.unit, name).toBe("Percent");
    }
    expect(plugins).not.toHaveProperty("cpu");
  });

  // The disk plugin tags device, fstype, path and mode; only a rollup to `path`, with the
  // original dropped, leaves the catalog's one set. No drop_device: an original reading with only
  // `path` would get no rollup and be dropped whole.
  test("roll disk up to the catalog's set and drop the original", () => {
    expect(CONFIG.metrics.aggregation_dimensions).toEqual(effectiveSets(disk!).map((s) => s.dims));
    expect(plugins["disk"]?.["resources"]).toEqual(disk?.values?.["path"]);
    expect(plugins["disk"]?.["drop_original_metrics"]).toEqual(["disk_used_percent"]);
    expect(plugins["disk"]).not.toHaveProperty("drop_device");
    expect(CONFIG.metrics).not.toHaveProperty("append_dimensions");
    // The `host` tag goes only with omit_hostname, which mem_used_percent's empty set needs.
    expect(byName("mem_used_percent")?.sets).toEqual([{ dims: [] }]);
    expect(CONFIG.agent["omit_hostname"]).toBe(true);
  });

  test("sample once a minute", () => {
    expect(CONFIG.agent["metrics_collection_interval"]).toBe(60);
  });
});

describe("the agent itself", () => {
  // The start wrapper translates the config again at every start, with the unit's environment:
  // without a region in the file an on-premises agent fails to start (AD-8).
  test("names its region, and runs as cwagent", () => {
    expect(CONFIG.agent["region"]).toBe("eu-central-1");
    expect(CONFIG.agent["run_as_user"]).toBe("cwagent");
  });

  // The dual-stack endpoints have AAAA records, and IPv6 would leave from an address the role's
  // aws:SourceIp refuses.
  test("uses the standard regional endpoints", () => {
    expect(CONFIG.agent["use_dualstack_endpoint"]).toBe(false);
    expect(RAW).not.toContain("endpoint_override");
    expect(RAW).not.toContain("api.aws");
  });

  test("reads the credentials the signing helper writes", () => {
    const toml = read("../cloudwatch-agent/common-config.toml");
    expect(toml).toMatch(/^\[credentials\]$/m);
    expect(toml).toMatch(/^\s*shared_credential_profile = "AmazonCloudWatchAgent"$/m);
    expect(toml).toMatch(/^\s*shared_credential_file = "\/run\/x402-cloudwatch\/credentials"$/m);
  });
});
