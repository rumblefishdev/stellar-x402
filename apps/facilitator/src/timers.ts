// Timers for the RPC stall tracker (rpc-stall.ts) and the search vectors' loop, which take one as `schedule`; tests pass a
// fake.

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
