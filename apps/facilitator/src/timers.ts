// Timers the 0027 metrics share: the EMF writer (adapters/emf-metrics.ts) and the RPC stall
// tracker (rpc-stall.ts) take one as `schedule`, and tests pass a fake.

/** Injectable timers. The default is the global timers, `unref`'d so they never hold the process. */
export type Scheduler = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const unrefTimers: Scheduler = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
