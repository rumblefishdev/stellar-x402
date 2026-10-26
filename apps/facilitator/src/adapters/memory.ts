import type { StellarNetwork } from "@stellar-x402/config";
import {
  HashConflictError,
  type CatalogEntry,
  type CatalogPage,
  type CatalogQuery,
  type CatalogStore,
  type UpsertOutcome,
  type ChannelLease,
  type ClaimResult,
  type NewSettlement,
  type RateLimitHit,
  type RateLimitStore,
  type ReserveResult,
  type SettlementKey,
  type SettlementRecord,
  type SettlementState,
  type SettlementStore,
  type SettlementUpdate,
  type SpendReservation,
  type SpendScope,
  type SpendStore,
  type Stores,
} from "../ports/index.js";
import {
  assertLedger,
  assertStroops,
  extensionKeys,
  isFinal,
  isForward,
  mergeCatalogEntry,
  windowEnd,
} from "./rules.js";

/**
 * In-memory adapters of the four ports (AD-7), for `STORE=memory` and for tests. State lives in
 * the process and a restart loses it. Reads and writes copy, so a caller can't change stored state
 * by mutating an object, just as with a real store.
 *
 * Each method finishes its check and its write without an `await` in between, which makes it
 * atomic on Node's single thread.
 */
export function memoryStores(): Stores {
  return {
    settlements: new MemorySettlementStore(),
    catalog: new MemoryCatalogStore(),
    rateLimits: new MemoryRateLimitStore(),
    spend: new MemorySpendStore(),
  };
}

export class MemorySettlementStore implements SettlementStore {
  private readonly records = new Map<SettlementKey, SettlementRecord>();
  /** The record each hash belongs to. */
  private readonly hashes = new Map<string, SettlementKey>();
  private readonly leases = new Map<string, ChannelLease>();

  async claim(settlement: NewSettlement): Promise<ClaimResult> {
    const existing = this.records.get(settlement.key);
    if (existing) return { claimed: false, existing: structuredClone(existing) };
    const record: SettlementRecord = {
      ...structuredClone(settlement),
      state: "claimed",
      hashes: [],
      updatedAt: settlement.createdAt,
    };
    this.records.set(record.key, record);
    return { claimed: true, record: structuredClone(record) };
  }

  async get(key: SettlementKey): Promise<SettlementRecord | undefined> {
    return structuredClone(this.records.get(key));
  }

  async findByHash(hash: string): Promise<SettlementRecord | undefined> {
    const key = this.hashes.get(hash);
    return key === undefined ? undefined : structuredClone(this.records.get(key));
  }

  async addHash(key: SettlementKey, hash: string, updatedAt: number): Promise<boolean> {
    const record = this.records.get(key);
    if (!record || isFinal(record.state)) return false;
    const owner = this.hashes.get(hash);
    if (owner === key) return true;
    if (owner !== undefined) throw new HashConflictError(hash);
    this.hashes.set(hash, key);
    record.hashes.push(hash);
    if (record.state === "claimed") record.state = "signed";
    record.updatedAt = updatedAt;
    return true;
  }

  async markSuccessAnswered(key: SettlementKey, at: number): Promise<boolean> {
    const record = this.records.get(key);
    if (record?.state !== "success" || record.successAnsweredAt !== undefined) return false;
    // Not `updatedAt`: the mark records an answer, not a step in the lifecycle.
    record.successAnsweredAt = at;
    return true;
  }

  async transition(
    key: SettlementKey,
    expected: SettlementState,
    update: SettlementUpdate,
  ): Promise<SettlementRecord | undefined> {
    if (update.feeCharged !== undefined) assertStroops(update.feeCharged, "feeCharged");
    const record = this.records.get(key);
    if (!record || record.state !== expected || !isForward(expected, update.state))
      return undefined;
    Object.assign(record, structuredClone(update));
    return structuredClone(record);
  }

  async listNonFinal(network: StellarNetwork): Promise<SettlementRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.network === network && !isFinal(record.state))
      .map((record) => structuredClone(record));
  }

  async acquireLease(
    name: string,
    holder: string,
    ttlMs: number,
    now: number,
  ): Promise<ChannelLease | undefined> {
    const lease = this.leases.get(name);
    if (lease && lease.holder !== holder && now <= lease.expiresAt) return undefined;
    const taken = { name, holder, expiresAt: now + ttlMs };
    this.leases.set(name, taken);
    return { ...taken };
  }

  async renewLease(name: string, holder: string, ttlMs: number, now: number): Promise<boolean> {
    const lease = this.leases.get(name);
    if (!lease || lease.holder !== holder || now > lease.expiresAt) return false;
    lease.expiresAt = now + ttlMs;
    return true;
  }

  async releaseLease(name: string, holder: string): Promise<void> {
    if (this.leases.get(name)?.holder === holder) this.leases.delete(name);
  }
}

export class MemoryCatalogStore implements CatalogStore {
  /** Insertion order is the stable listing order. */
  private readonly entries = new Map<string, CatalogEntry>();

  async upsert(entry: CatalogEntry): Promise<UpsertOutcome> {
    assertLedger(entry.ledger);
    const { network, payTo, method, resourceUrl } = entry.key;
    const id = JSON.stringify([network, payTo, method, resourceUrl]);
    const stored = this.entries.get(id);
    const { merged, stale } = mergeCatalogEntry(stored, entry);
    this.entries.set(id, structuredClone(merged));
    return stale ? "stale" : stored ? "updated" : "inserted";
  }

  async list(query: CatalogQuery): Promise<CatalogPage> {
    const { type, payTo, network, extensions, limit, offset } = query;
    const matches = [...this.entries.values()].filter(
      ({ key, resource }) =>
        (type === undefined || resource.type === type) &&
        (payTo === undefined || key.payTo === payTo) &&
        (network === undefined || key.network === network) &&
        (extensions === undefined || extensionKeys(resource).includes(extensions)),
    );
    return {
      items: matches.slice(offset, offset + limit).map(({ resource }) => structuredClone(resource)),
      total: matches.length,
    };
  }
}

export class MemoryRateLimitStore implements RateLimitStore {
  // One entry per key; the pruner deletes ended windows.
  private readonly windows = new Map<string, RateLimitHit>();

  async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const resetAt = windowEnd(now, windowMs);
    const stored = this.windows.get(key);
    // A hit from an older window (a lagging clock) counts in the stored, newer one.
    const counted =
      stored && stored.resetAt >= resetAt
        ? { count: stored.count + 1, resetAt: stored.resetAt }
        : { count: 1, resetAt };
    this.windows.set(key, counted);
    return { ...counted };
  }

  async prune(before: number, limit: number): Promise<number> {
    let pruned = 0;
    for (const [key, { resetAt }] of this.windows) {
      if (pruned === limit) break;
      if (resetAt < before) {
        this.windows.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}

interface Reservation {
  amount: bigint;
  at: number;
  scopes: SpendScope[];
  state: "reserved" | "committed";
}

export class MemorySpendStore implements SpendStore {
  // `sum` scans every reservation the pruner has kept: fine for tests and dev runs (deployments
  // use the PostgreSQL stores).
  private readonly reservations = new Map<string, Reservation>();
  private readonly failures = new Map<SpendScope, number>();
  private readonly breakers = new Map<SpendScope, number>();

  async reserve({ id, amount, limits, now }: SpendReservation): Promise<ReserveResult> {
    assertStroops(amount, "amount");
    for (const limit of limits) assertStroops(limit.maxStroops, "maxStroops");
    if (this.reservations.has(id)) return { reserved: true };
    for (const limit of limits)
      if (this.sum(limit.scope, limit.windowMs, now) + amount > limit.maxStroops)
        return { reserved: false, scope: limit.scope };
    this.reservations.set(id, {
      amount,
      at: now,
      scopes: limits.map((limit) => limit.scope),
      state: "reserved",
    });
    return { reserved: true };
  }

  async commit(id: string, feeCharged: bigint): Promise<boolean> {
    assertStroops(feeCharged, "feeCharged");
    const reservation = this.reservations.get(id);
    if (!reservation) return false;
    Object.assign(reservation, { amount: feeCharged, state: "committed" });
    return true;
  }

  async release(id: string): Promise<void> {
    if (this.reservations.get(id)?.state === "reserved") this.reservations.delete(id);
  }

  async used(scope: SpendScope, windowMs: number, now: number): Promise<bigint> {
    return this.sum(scope, windowMs, now);
  }

  async prune(before: number, limit: number): Promise<number> {
    let pruned = 0;
    for (const [id, { at }] of this.reservations) {
      if (pruned === limit) break;
      if (at < before) {
        this.reservations.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  async recordFailure(scope: SpendScope): Promise<number> {
    const failures = (this.failures.get(scope) ?? 0) + 1;
    this.failures.set(scope, failures);
    return failures;
  }

  async recordSuccess(scope: SpendScope): Promise<void> {
    this.failures.delete(scope);
  }

  async openBreaker(scope: SpendScope, until: number): Promise<void> {
    this.breakers.set(scope, Math.max(this.breakers.get(scope) ?? -Infinity, until));
  }

  async breakerOpenUntil(scope: SpendScope, now: number): Promise<number | undefined> {
    const until = this.breakers.get(scope);
    return until !== undefined && now < until ? until : undefined;
  }

  private sum(scope: SpendScope, windowMs: number, now: number): bigint {
    let total = 0n;
    for (const { amount, at, scopes } of this.reservations.values())
      if (scopes.includes(scope) && at > now - windowMs) total += amount;
    return total;
  }
}
