import { randomUUID } from "node:crypto";
import type { StellarNetwork } from "@stellar-x402/config";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { SettlementStore } from "../ports/index.js";

/** The lease of one network's channel set, so testnet and pubnet never wait on each other. */
export const leaseName = (network: StellarNetwork) => `${network}:channels`;

export interface LeaseKeeperDeps {
  store: Pick<SettlementStore, "acquireLease" | "renewLease" | "releaseLease">;
  network: StellarNetwork;
  /** `LEASE_TTL_MS`; the keeper tries every third of it (0025 decision 2). */
  ttlMs: number;
  logger: Logger;
  metrics: Metrics;
  /** A new one for every process start by default, so a restart never inherits a lease. */
  holder?: string;
  /** The app clock, as for every stored time. */
  now?: () => number;
}

export interface LeaseKeeper {
  /** Whether this process may send through the channel set now; no store call (decision 4). */
  held(): boolean;
  /** Tries to take the lease once, then every `ttlMs / 3` until `close()`. Never rejects. */
  start(): Promise<void>;
  /** One attempt: renews a held lease or tries to take a free one. For tests. */
  runOnce(): Promise<void>;
  /** Stops the timer and waits for an attempt under way. The lease stays until its TTL. */
  close(): Promise<void>;
  /**
   * `close()`, then gives the lease up if this process holds it, so the next process takes it at
   * its next attempt instead of after the TTL. Only after the drain (0025 decision 10). Never
   * rejects: a failed release leaves the lease to its TTL.
   */
  release(): Promise<void>;
}

/**
 * Keeps this process's lease on its network's channel set (AD-17, 0025). Without it, `/settle`
 * answers 503 and the keeper keeps trying (decision 1). A renewal that fails or returns `false`
 * drops it at once (decision 3): only the store knows whether another process took over.
 *
 * `held()` also ends at the expiry this process wrote, measured on its own clock from the start
 * of the call that wrote it, so a renewal stuck in a hung store call can't keep the flag up past
 * the lease itself.
 */
export function createLeaseKeeper(deps: LeaseKeeperDeps): LeaseKeeper {
  const { store, network, ttlMs, logger, metrics, now = Date.now } = deps;
  const name = leaseName(network);
  const holder = deps.holder ?? randomUUID();
  const intervalMs = ttlMs / 3;
  /** The expiry this process last wrote; `undefined` while it doesn't hold the lease. */
  let expiresAt: number | undefined;

  const changed = (held: boolean) => metrics.increment("lease_changes_total", { held: `${held}` });
  const lose = (reason: "taken" | "expired" | "store_failed", error?: unknown) => {
    expiresAt = undefined;
    logger.warn("lease_lost", {
      network,
      lease: name,
      reason,
      ...(error !== undefined && { error }),
    });
    changed(false);
  };

  const runOnce = async () => {
    const at = now();
    const previous = expiresAt;
    const had = previous !== undefined;
    try {
      const ok = had
        ? await store.renewLease(name, holder, ttlMs, at)
        : (await store.acquireLease(name, holder, ttlMs, at)) !== undefined;
      if (ok) {
        expiresAt = at + ttlMs;
        if (!had) {
          logger.info("lease_acquired", { network, lease: name });
          changed(true);
        }
      } else if (had) {
        // Past its expiry another process may hold it; `renewLease` can't tell which.
        lose(at > previous ? "expired" : "taken");
      }
    } catch (error) {
      if (had) lose("store_failed", error);
      else logger.warn("lease_acquire_failed", { network, lease: name, error });
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let closed = false;
  const attempt = () => {
    running = runOnce().finally(() => {
      running = undefined;
      schedule();
    });
    return running;
  };
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(() => void attempt(), intervalMs);
    timer.unref();
  };

  const close = async () => {
    closed = true;
    clearTimeout(timer);
    await running;
  };

  return {
    held: () => expiresAt !== undefined && now() < expiresAt,
    start: attempt,
    runOnce,
    close,
    async release() {
      await close();
      if (expiresAt === undefined) return;
      expiresAt = undefined;
      try {
        await store.releaseLease(name, holder);
        logger.info("lease_released", { network, lease: name });
      } catch (error) {
        logger.warn("lease_release_failed", { network, lease: name, error });
      }
      changed(false);
    },
  };
}
