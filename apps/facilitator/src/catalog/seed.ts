import { setTimeout as sleep } from "node:timers/promises";
import { SellerFetchError, guardedFetch } from "@stellar-x402/seller-fetch";
import robotsParser from "robots-parser";
import type { Cataloger, SeedResult } from "./cataloger.js";
import { SELLER_USER_AGENT } from "./seller-check.js";

/**
 * The largest seller file read: twice the largest measured (219,455 B on 2026-11-20, of 31
 * files with a median of 7,707 B), 0155 decision 11.
 */
export const SEED_FILE_BYTES = 512 * 1024;
/**
 * The wait after each request the seed sends a host: 60 a minute, so the largest measured file
 * (581 URLs, 2026-11-23) is seeded in about 10 minutes. Checks after payments, which peaked at 3 a
 * minute across all sellers (testnet, 2026-11-03 to 11-25), keep their own budget (decision 12). A
 * URL costs one request, a second when its 402 declares another method or an MCP tool.
 */
export const REQUEST_GAP_MS = 1_000;
/** The robots.txt size a parser must read, RFC 9309 §2.5. */
const ROBOTS_BYTES = 500 * 1024;
/** Our robot's name in robots.txt groups: the product token of `SELLER_USER_AGENT`. */
const ROBOT_NAME = "stellar-bazaar";
/** As long as a seller check may take (`cataloger.ts`'s seller timeout). */
const FILE_TIMEOUT_MS = 10_000;
/** The only methods a check sends: real listings use these two alone (ADR 0008). */
const METHODS = ["GET", "POST"];

/**
 * The hosts file (decision 13): a host or a whole origin a line; blank lines and `#` skipped. A
 * line that isn't a host is returned in `invalid`, for the command to refuse the file.
 */
export function parseHosts(text: string): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const url = line.includes("://") ? line : `https://${line}`;
    if (!URL.canParse(url)) {
      invalid.push(line);
      continue;
    }
    const origin = new URL(url).origin;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, invalid };
}

/**
 * An entry of the seller's file the seed doesn't ask, named in the report: a URL on another host
 * than the file's (decision 9), a method other than GET or POST, or no URL that parses.
 */
export interface Skipped {
  entry: string;
  method: string;
  reason: "off_host" | "other_method" | "unreadable" | "robots";
}

export type FileResources =
  | { ok: true; resources: { url: string; method: string }[]; skipped: Skipped[] }
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
  const skipped: Skipped[] = [];
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
    if (typeof written !== "string" || !URL.canParse(written, origin)) {
      // Named by its kind, not printed: a seller's entry can nest too deep to stringify.
      const entry = typeof item === "string" ? item.slice(0, 200) : kindOf(item);
      skipped.push({ entry, method, reason: "unreadable" });
      continue;
    }
    const url = new URL(written, origin);
    if (url.host !== host) {
      skipped.push({ entry: url.href, method, reason: "off_host" });
      continue;
    }
    if (!METHODS.includes(method)) {
      skipped.push({ entry: url.href, method, reason: "other_method" });
      continue;
    }
    if (seen.has(`${method} ${url.href}`)) continue;
    seen.add(`${method} ${url.href}`);
    resources.push({ url: url.href, method });
  }
  return { ok: true, resources, skipped };
}

function kindOf(item: unknown): string {
  if (Array.isArray(item)) return "an array";
  if (item === null) return "null";
  if (typeof item === "object") return "an object";
  return `a ${typeof item}`;
}

/** How seeding one host ended: its file, then a result per listing. */
export interface HostReport {
  origin: string;
  /** `ok`, or why the file couldn't be read. */
  file: string;
  /** URLs on the file's own host, each asked. */
  listed: number;
  skipped: Skipped[];
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

/**
 * The host's robots.txt rules for our robot (0155, owner 2026-11-23), by RFC 9309: a 4xx means no
 * rules (§2.3.1.3); any other answer than 200 (a 5xx, §2.3.1.4), or no answer at all, means every
 * URL is off limits, so the host is not asked. A redirect is not followed, as for every seller request: measured hosts that
 * redirect robots.txt redirect their `/.well-known/x402` too, so they are not seeded either way.
 */
async function readRobots(
  origin: string,
  listLocal: boolean,
): Promise<{ isDisallowed(url: string, ua: string): boolean | undefined } | undefined> {
  const limits = {
    timeoutMs: FILE_TIMEOUT_MS,
    maxResponseBytes: ROBOTS_BYTES,
    allowInsecureLocal: listLocal,
  };
  const fetch = guardedFetch(limits, AbortSignal.timeout(FILE_TIMEOUT_MS));
  const url = new URL("/robots.txt", origin).href;
  const response = await fetch(url, { headers: { "user-agent": SELLER_USER_AGENT } });
  if (response.status >= 400 && response.status < 500) return undefined;
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  return robotsParser(url, await response.text());
}

/** Seeds one host: its file, then each URL in turn, a failure in one never stopping the next. */
async function seedHost(origin: string, cataloger: Cataloger, deps: SeedDeps): Promise<HostReport> {
  const report: HostReport = {
    origin,
    file: "ok",
    listed: 0,
    skipped: [],
    results: [],
  };
  let robots: Awaited<ReturnType<typeof readRobots>>;
  try {
    robots = await readRobots(origin, deps.listLocal);
  } catch (error) {
    // Named as robots.txt's, so the report never blames the seller's file, which wasn't asked.
    report.file = `robots.txt: ${failure(error)}`;
    return report;
  }
  const disallowed = (url: string) => robots?.isDisallowed(url, ROBOT_NAME) === true;
  // The seller's file is a URL like any other: a host that disallows it is not asked (decision 3).
  const fileUrl = new URL("/.well-known/x402", origin).href;
  if (disallowed(fileUrl)) {
    report.file = "disallowed by robots.txt";
    report.skipped.push({ entry: fileUrl, method: "GET", reason: "robots" });
    return report;
  }
  let file: unknown;
  try {
    file = await readFile402(origin, deps.listLocal);
  } catch (error) {
    report.file = failure(error);
    return report;
  }
  const found = fileResources(origin, file);
  if (!found.ok) {
    report.file = found.reason;
    return report;
  }
  const resources = [];
  for (const resource of found.resources) {
    if (disallowed(resource.url))
      found.skipped.push({ entry: resource.url, method: resource.method, reason: "robots" });
    else resources.push(resource);
  }
  report.listed = resources.length;
  report.skipped = found.skipped;
  const wait = deps.wait ?? sleep;
  for (const [i, { url, method }] of resources.entries()) {
    const { results, requests } = await cataloger.seed(url, method, disallowed);
    report.results.push(...results);
    if (i < resources.length - 1) await wait(REQUEST_GAP_MS * requests);
  }
  return report;
}

function failure(error: unknown): string {
  return error instanceof SellerFetchError
    ? [error.code, error.detail].filter(Boolean).join(": ")
    : (error as Error).message;
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
 * outcome, reason, detail) and per skipped entry (outcome `skipped`), a line per host, the totals,
 * and each `payTo` seen on more than one host (decision 12), since a host can name another seller's
 * account (ADR 0008).
 */
export function reportLines(reports: HostReport[]): string[] {
  const lines: string[] = [];
  for (const { results } of reports)
    for (const r of results)
      lines.push(
        [r.url, r.method, r.network, r.payTo, r.outcome, r.reason, r.detail]
          .map((field) => printable(field ?? ""))
          .join("\t"),
      );
  for (const { skipped } of reports)
    for (const { entry, method, reason } of skipped)
      lines.push([entry, method, "", "", "skipped", reason, ""].map(printable).join("\t"));
  const written = (r: SeedResult) => r.outcome === "refreshed";
  const hostsOf = new Map<string, Set<string>>();
  for (const report of reports) {
    const count = report.results.filter(written).length;
    const skips = (reason: Skipped["reason"]) =>
      report.skipped.filter((skip) => skip.reason === reason).length;
    // A second request robots.txt disallows is a result of the check, counted with the skips.
    const robotsResults = report.results.filter((r) => r.reason === "robots").length;
    lines.push(
      `host ${report.origin}: file ${report.file}, ${report.listed} listed, ` +
        `${skips("off_host")} on another host, ${skips("other_method")} other methods, ` +
        `${skips("unreadable")} unreadable, ${skips("robots") + robotsResults} refused by robots.txt, ` +
        `${count} written`,
    );
    for (const r of report.results) {
      if (r.payTo === undefined) continue;
      const hosts = hostsOf.get(r.payTo) ?? new Set<string>();
      hosts.add(report.origin);
      hostsOf.set(r.payTo, hosts);
    }
  }
  const all = reports.flatMap((report) => report.results).filter(written);
  const added = all.filter((r) => r.reason === "inserted").length;
  const updated = all.filter((r) => r.reason === "updated").length;
  const withListing = reports.filter((report) => report.results.some(written)).length;
  const accounts = new Set(
    reports.flatMap((report) => report.results.filter(written).map((r) => r.payTo)),
  );
  lines.push(
    `total: ${all.length} written (${added} added, ${updated} updated), ` +
      `${withListing} hosts with a listing, ${accounts.size} payTo`,
  );
  for (const [payTo, hosts] of hostsOf)
    if (hosts.size > 1)
      lines.push(`payTo ${printable(payTo)} on ${hosts.size} hosts: ${[...hosts].join(", ")}`);
  return lines;
}

/** A seller's text can carry terminal escapes: no control character is printed. */
function printable(text: string): string {
  return text.replace(/\p{Cc}/gu, " ");
}
