import type { StellarNetwork } from "@stellar-x402/config";
import type { PaymentRequirements } from "@x402/core/types";
import {
  FINAL_SETTLEMENT_STATES,
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

/**
 * In-memory adapters of the four ports (AD-7), for `STORE=memory` and for tests. State lives in
 * the process and a restart loses it; the durable adapters come in 0022. Reads and writes copy,
 * so a caller can't change stored state by mutating an object, just as with a real store.
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

const ORDER: Record<SettlementState, number> = {
  claimed: 0,
  signed: 1,
  pending: 2,
  success: 3,
  failed: 3,
  rejected: 3,
  expired: 3,
};

const isFinal = (state: SettlementState) => FINAL_SETTLEMENT_STATES.includes(state);

export class MemorySettlementStore implements SettlementStore {
  private readonly records = new Map<SettlementKey, SettlementRecord>();
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
    // ponytail: linear scan, fine for tests and one testnet process; durable adapters index hashes.
    for (const record of this.records.values())
      if (record.hashes.includes(hash)) return structuredClone(record);
    return undefined;
  }

  async addHash(key: SettlementKey, hash: string, updatedAt: number): Promise<boolean> {
    const record = this.records.get(key);
    if (!record || isFinal(record.state)) return false;
    if (record.hashes.includes(hash)) return true;
    record.hashes.push(hash);
    if (record.state === "claimed") record.state = "signed";
    record.updatedAt = updatedAt;
    return true;
  }

  async transition(
    key: SettlementKey,
    expected: SettlementState,
    update: SettlementUpdate,
  ): Promise<SettlementRecord | undefined> {
    const record = this.records.get(key);
    // A final state is the end of the lifecycle: nothing moves on from it.
    if (!record || record.state !== expected || isFinal(expected)) return undefined;
    // Only forward: a same-state update would let two concurrent callers both win.
    if (ORDER[update.state] <= ORDER[expected]) return undefined;
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

const requirementKey = (r: PaymentRequirements) => `${r.scheme}|${r.network}|${r.asset}`;

export class MemoryCatalogStore implements CatalogStore {
  /** Insertion order is the stable listing order. */
  private readonly entries = new Map<string, CatalogEntry>();

  async upsert(entry: CatalogEntry): Promise<UpsertOutcome> {
    const { network, payTo, method, resourceUrl } = entry.key;
    const id = JSON.stringify([network, payTo, method, resourceUrl]);
    const stored = this.entries.get(id);
    if (stored && Date.parse(entry.resource.lastUpdated) < Date.parse(stored.resource.lastUpdated))
      return "stale";
    const accepts = new Map<string, PaymentRequirements>();
    for (const requirement of stored?.resource.accepts ?? [])
      accepts.set(requirementKey(requirement), requirement);
    for (const requirement of entry.resource.accepts)
      accepts.set(requirementKey(requirement), requirement);
    this.entries.set(
      id,
      structuredClone({
        key: entry.key,
        keyVersion: entry.keyVersion,
        resource: { ...entry.resource, accepts: [...accepts.values()] },
      }),
    );
    return stored ? "updated" : "inserted";
  }

  async list(query: CatalogQuery): Promise<CatalogPage> {
    const { type, payTo, network, extensions, limit, offset } = query;
    const matches = [...this.entries.values()].filter(
      ({ key, resource }) =>
        (type === undefined || resource.type === type) &&
        (payTo === undefined || key.payTo === payTo) &&
        (network === undefined || key.network === network) &&
        // An own key with a value: not a prototype key, and not one JSON storage would drop.
        (extensions === undefined ||
          (resource.extensions?.[extensions] !== undefined &&
            Object.hasOwn(resource.extensions, extensions))),
    );
    return {
      items: matches.slice(offset, offset + limit).map(({ resource }) => structuredClone(resource)),
      total: matches.length,
    };
  }
}

export class MemoryRateLimitStore implements RateLimitStore {
  // ponytail: one entry per key, never pruned; add a sweep if a long-lived process sees many IPs.
  private readonly windows = new Map<string, RateLimitHit>();

  async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
    const current = this.windows.get(key);
    const count = current?.resetAt === resetAt ? current.count + 1 : 1;
    this.windows.set(key, { count, resetAt });
    return { count, resetAt };
  }
}

interface Reservation {
  amount: bigint;
  at: number;
  scopes: SpendScope[];
}

export class MemorySpendStore implements SpendStore {
  // ponytail: reservations are never pruned, so memory and each `sum` scan grow with the process's
  // settlements. Fine for tests and dev runs (deployments use the 0022 stores); prune past the
  // longest window if a memory store ever runs for long.
  private readonly reservations = new Map<string, Reservation>();
  private readonly failures = new Map<SpendScope, number>();
  private readonly breakers = new Map<SpendScope, number>();

  async reserve({ id, amount, limits, now }: SpendReservation): Promise<ReserveResult> {
    if (this.reservations.has(id)) return { reserved: true };
    for (const limit of limits)
      if (this.sum(limit.scope, limit.windowMs, now) + amount > limit.maxStroops)
        return { reserved: false, scope: limit.scope };
    this.reservations.set(id, { amount, at: now, scopes: limits.map((limit) => limit.scope) });
    return { reserved: true };
  }

  async commit(id: string, feeCharged: bigint, now: number): Promise<void> {
    const reservation = this.reservations.get(id);
    if (reservation) Object.assign(reservation, { amount: feeCharged, at: now });
  }

  async release(id: string): Promise<void> {
    this.reservations.delete(id);
  }

  async used(scope: SpendScope, windowMs: number, now: number): Promise<bigint> {
    return this.sum(scope, windowMs, now);
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
    this.breakers.set(scope, until);
  }

  async breakerOpenUntil(scope: SpendScope, now: number): Promise<number | undefined> {
    const until = this.breakers.get(scope);
    return until !== undefined && now < until ? until : undefined;
  }

  private sum(scope: SpendScope, windowMs: number, now: number): bigint {
    let total = 0n;
    for (const { amount, at, scopes } of this.reservations.values())
      if (scopes.includes(scope) && at > now - windowMs && at <= now) total += amount;
    return total;
  }
}
