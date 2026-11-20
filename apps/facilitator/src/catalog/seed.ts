import { setTimeout as sleep } from "node:timers/promises";
import { SellerFetchError, guardedFetch } from "@stellar-x402/seller-fetch";
import type { Cataloger, SeedResult } from "./cataloger.js";
import { SELLER_USER_AGENT } from "./seller-check.js";

/**
 * The largest seller file read: twice the largest measured (219,455 B on 2026-11-20, of 31
 * files with a median of 7,707 B), 0155 decision 11.
 */
export const SEED_FILE_BYTES = 512 * 1024;
/**
 * The wait between two resource URLs of one host. Each URL costs two requests (the one that learns
 * its listing, then the check), so a host gets at most 20 a minute: below the 30 checks a minute a
 * host's budget allows checks after payments (ADR 0008), which keep their share (decision 12).
 */
export const SEED_GAP_MS = 6_000;
/** As long as a seller check may take (`cataloger.ts`'s seller timeout). */
const FILE_TIMEOUT_MS = 10_000;
/** The only methods a check sends: real listings use these two alone (ADR 0008). */
const METHODS = ["GET", "POST"];

/** The hosts file (decision 13): a host or a whole origin a line; blank lines and `#` skipped. */
export function parseHosts(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => (line.includes("://") ? line : `https://${line}`));
}

export type FileResources =
  | {
      ok: true;
      resources: { url: string; method: string }[];
      /** URLs on another host than the file's, skipped (decision 9). */
      offHost: number;
      /** URLs with a method other than GET or POST, skipped. */
      otherMethod: number;
    }
  | { ok: false; reason: "no_resources" };

/**
 * The resource URLs a seller's `/.well-known/x402` lists on its own host. Measured files list them
 * as strings, `"METHOD URL"` strings or objects with `url`, `resource` or `path` and an optional
 * `method` (2026-11-20, 31 files); a relative URL is the file's host's. Without a method, GET: the
 * check then asks with the method the seller's 402 declares (decision 10).
 */
export function fileResources(origin: string, file: unknown): FileResources {
  const listed = (file as { resources?: unknown } | null)?.resources;
  if (!Array.isArray(listed)) return { ok: false, reason: "no_resources" };
  const host = new URL(origin).host;
  const seen = new Set<string>();
  const resources: { url: string; method: string }[] = [];
  let offHost = 0;
  let otherMethod = 0;
  for (const item of listed) {
    let written: unknown;
    let method = "GET";
    if (typeof item === "string") {
      const [first, second] = item.trim().split(/\s+/);
      written = second === undefined ? first : second;
      if (second !== undefined) method = first!.toUpperCase();
    } else if (typeof item === "object" && item !== null) {
      const fields = item as Record<string, unknown>;
      written = fields.url ?? fields.resource ?? fields.path;
      if (typeof fields.method === "string") method = fields.method.toUpperCase();
    }
    if (typeof written !== "string" || !URL.canParse(written, origin)) continue;
    const url = new URL(written, origin);
    if (url.host !== host) {
      offHost++;
      continue;
    }
    if (!METHODS.includes(method)) {
      otherMethod++;
      continue;
    }
    if (seen.has(`${method} ${url.href}`)) continue;
    seen.add(`${method} ${url.href}`);
    resources.push({ url: url.href, method });
  }
  return { ok: true, resources, offHost, otherMethod };
}

/** How seeding one host ended: its file, then a result per listing. */
export interface HostReport {
  origin: string;
  /** `ok`, or why the file couldn't be read. */
  file: string;
  /** URLs on the file's own host, each asked. */
  listed: number;
  offHost: number;
  otherMethod: number;
  results: SeedResult[];
}

interface SeedDeps {
  /** Development only: a seller on this machine, over http. */
  listLocal: boolean;
  /** Waits between two URLs of one host; tests pass one that doesn't. */
  wait?: (ms: number) => Promise<unknown>;
}

/** Reads the host's `/.well-known/x402` through the seller guard, or says why it can't. */
async function readFile402(origin: string, listLocal: boolean): Promise<unknown> {
  const limits = {
    timeoutMs: FILE_TIMEOUT_MS,
    maxResponseBytes: SEED_FILE_BYTES,
    allowInsecureLocal: listLocal,
  };
  const fetch = guardedFetch(limits, AbortSignal.timeout(FILE_TIMEOUT_MS));
  const response = await fetch(new URL("/.well-known/x402", origin).href, {
    headers: { "user-agent": SELLER_USER_AGENT },
  });
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("not_json");
  }
}

/** Seeds one host: its file, then each URL in turn, a failure in one never stopping the next. */
async function seedHost(origin: string, cataloger: Cataloger, deps: SeedDeps): Promise<HostReport> {
  const report: HostReport = {
    origin,
    file: "ok",
    listed: 0,
    offHost: 0,
    otherMethod: 0,
    results: [],
  };
  let file: unknown;
  try {
    file = await readFile402(origin, deps.listLocal);
  } catch (error) {
    report.file = error instanceof SellerFetchError ? error.code : (error as Error).message;
    return report;
  }
  const found = fileResources(origin, file);
  if (!found.ok) {
    report.file = found.reason;
    return report;
  }
  report.listed = found.resources.length;
  report.offHost = found.offHost;
  report.otherMethod = found.otherMethod;
  const wait = deps.wait ?? sleep;
  for (const [i, { url, method }] of found.resources.entries()) {
    if (i > 0) await wait(SEED_GAP_MS);
    report.results.push(...(await cataloger.seed(url, method)));
  }
  return report;
}

/** Seeds every host at once, each at its own pace: one host's failure never stops another's. */
export async function seedHosts(
  origins: string[],
  cataloger: Cataloger,
  deps: SeedDeps,
): Promise<HostReport[]> {
  return Promise.all(origins.map((origin) => seedHost(origin, cataloger, deps)));
}

/**
 * The run's report for the operator: a tab-separated line per result (URL, method, network, payTo,
 * outcome, reason, detail), a line per host, the totals, and each `payTo` seen on more than one
 * host (decision 12), since a host can name another seller's account (ADR 0008).
 */
export function reportLines(reports: HostReport[]): string[] {
  const lines: string[] = [];
  for (const { results } of reports)
    for (const r of results)
      lines.push(
        [r.url, r.method, r.network, r.payTo, r.outcome, r.reason, r.detail]
          // A seller's text can carry terminal escapes: no control character is printed.
          .map((field) => (field ?? "").replace(/\p{Cc}/gu, " "))
          .join("\t"),
      );
  const written = (r: SeedResult) => r.outcome === "refreshed";
  const hostsOf = new Map<string, Set<string>>();
  for (const report of reports) {
    const count = report.results.filter(written).length;
    lines.push(
      `host ${report.origin}: file ${report.file}, ${report.listed} listed, ` +
        `${report.offHost} on another host, ${report.otherMethod} other methods, ${count} written`,
    );
    for (const r of report.results.filter(written)) {
      const hosts = hostsOf.get(r.payTo!) ?? new Set<string>();
      hosts.add(report.origin);
      hostsOf.set(r.payTo!, hosts);
    }
  }
  const total = reports.flatMap((report) => report.results).filter(written).length;
  const withListing = reports.filter((report) => report.results.some(written)).length;
  lines.push(`total: ${total} written, ${withListing} hosts with a listing, ${hostsOf.size} payTo`);
  for (const [payTo, hosts] of hostsOf)
    if (hosts.size > 1)
      lines.push(`payTo ${payTo} on ${hosts.size} hosts: ${[...hosts].join(", ")}`);
  return lines;
}
