import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps } from "./http/app.js";

export interface Started {
  port: number;
  close(): Promise<void>;
}

/**
 * How long `close()` waits for the drain after SIGTERM (0025 decision 11): Docker kills the
 * container at 180 s, which leaves 30 s for the cataloger, the pruner and the pools.
 */
export const SHUTDOWN_DEADLINE_MS = 150_000;

/**
 * How long requests still open after the drain may take before their connections are cut, within
 * the deadline: a `/verify` on one RPC URL fits, and a stalled client no longer holds the process
 * past it (0025 decision 23).
 */
export const SHUTDOWN_GRACE_MS = 15_000;

/**
 * How long an idle connection stays open: above `cloudflared`'s 90 s idle keep-alive, so the
 * server never closes a connection the tunnel is about to reuse, which it would answer with a 502
 * (ADR 0011). The header wait sits above it.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 125_000;

/** Starts the HTTP server on the graph `deps`. Tests call it with their own config and stores. */
export async function start(
  deps: AppDeps,
  opts: { shutdownDeadlineMs?: number; shutdownGraceMs?: number } = {},
): Promise<Started> {
  const { shutdownDeadlineMs = SHUTDOWN_DEADLINE_MS, shutdownGraceMs = SHUTDOWN_GRACE_MS } = opts;
  let closing = false;
  const server = createApp({ ...deps, closing: () => closing }).listen(deps.config.port);
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;
  await once(server, "listening");
  // The first balance reading comes before the lease, so `/settle` isn't refused for want of one
  // once it can serve. A failed read is logged, and the floor fails closed until one succeeds.
  await deps.floor?.start();
  // After listening, so `/verify` and `/supported` answer meanwhile. Sweeps run with or without the lease (0019
  // decision 37); `/settle` serves beside them (0019 decision 27) once the lease is held, and the
  // keeper keeps trying when it isn't (0025 decision 1).
  await deps.lease?.start();
  deps.reconciliation?.start();
  const { port } = server.address() as AddressInfo;
  deps.logger.info("listening", {
    port,
    network: deps.config.network,
    channels: deps.config.channels.length,
  });
  return {
    port,
    // The shutdown (0025): `/settle` answers 503 at once, the pool refuses every call that sent
    // nothing, and calls already sent run on while the keeper keeps renewing the lease (decision
    // 10). Once they and their record writes are done nothing can send, so the lease is given up
    // and the next process takes over within one attempt (decision 23). Until then the server
    // listens, so a new `/settle` still gets its 503 rather than a refused connection. Then it
    // closes: open requests get the grace, their connections are cut, and a sweep under way is
    // waited for, as sweeps need no lease (0019 decision 37). Past the deadline the open
    // connections are cut, and a drain still under way leaves the lease to its TTL (decision 11).
    // A transaction still unresolved can stay valid past that, until its payer's auth expires
    // (0073): the next process's sends on its channel may then fail with `txBadSeq` and rebuild.
    close: async () => {
      closing = true;
      const begun = Date.now();
      deps.logger.info("shutdown_started", { network: deps.config.network });
      // No new sweep starts; one under way is drained like the submissions, so its writes don't
      // reach the pools `main()` ends next.
      const swept = deps.reconciliation?.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), shutdownDeadlineMs);
        timer.unref();
      });
      const drained = (async () => {
        await deps.drain?.();
        return "drained" as const;
      })();
      let closed: Promise<void> | undefined;
      try {
        if ((await Promise.race([drained, deadline])) === "drained") {
          deps.logger.info("shutdown_drained", { ms: Date.now() - begun });
          await deps.lease?.release();
          closed = new Promise<void>((resolve, reject) =>
            server.close((e) => (e ? reject(e) : resolve())),
          );
          server.closeIdleConnections();
          const graced = new Promise<void>((resolve) => {
            grace = setTimeout(resolve, shutdownGraceMs);
            grace.unref();
          });
          await Promise.race([closed, graced, deadline]);
          server.closeAllConnections();
          const done = Promise.all([closed, swept]).then(() => "closed" as const);
          if ((await Promise.race([done, deadline])) === "closed") return;
          // Only a sweep is still under way: its record writes may fail once the pools end.
          deps.logger.warn("shutdown_deadline", { ms: Date.now() - begun, drained: true });
          return;
        }
        deps.logger.warn("shutdown_deadline", { ms: Date.now() - begun, drained: false });
        server.close();
        server.closeAllConnections();
        await deps.lease?.close();
      } catch (error) {
        // The server failed to close; if the drain didn't end either, the lease waits out its TTL.
        await deps.lease?.close();
        throw error;
      } finally {
        clearTimeout(timer);
        clearTimeout(grace);
        deps.floor?.stop();
        // Past the deadline the drain may still fail, or the late `server.close()` may.
        drained.catch(() => {});
        closed?.catch(() => {});
      }
    },
  };
}
