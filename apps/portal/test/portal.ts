import type { AddressInfo } from "node:net";
import { DEFAULT_ACCOUNT_PLANS, parseAccountPlans, type OwnerKeys } from "@stellar-x402/api-keys";
import {
  MemoryAccountPlanStore,
  MemoryAccountUsage,
  MemoryKeyStore,
} from "@stellar-x402/api-keys/testing";
import { afterEach } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { signHubToken, type Act } from "../src/hub-token.js";
import type { Logger } from "../src/logger.js";
import { sealer } from "../src/seal.js";

/** A Discord id whose account was created at `ms`. */
export const idCreatedAt = (ms: number): string => String((BigInt(ms) - 1_420_070_400_000n) << 22n);

/** A moment to run at (mid-month, so "this month" and "last month" are far from an edge). */
export const NOW = Date.UTC(2026, 10, 18, 12);
/** Two accounts a year or more old, and one made a minute before NOW. */
export const ACCOUNT_A = idCreatedAt(NOW - 365 * 86_400_000);
export const ACCOUNT_B = idCreatedAt(NOW - 730 * 86_400_000);
export const YOUNG_ACCOUNT = idCreatedAt(NOW - 60_000);
export const ownerOf = (id: string) => `discord:${id}`;

export const SECRET = Buffer.from("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=", "base64");
export const ENCRYPTION_KEY = Buffer.alloc(32, 7);
export const USERNAME = "nelly";

/** The registry in memory, counting what the app asks of it and failing on request. */
export class TestStore extends MemoryKeyStore {
  calls = 0;
  failing = false;

  override keysOf(owner: string): Promise<OwnerKeys> {
    return this.enter() ?? super.keysOf(owner);
  }
  override issue(key: Parameters<MemoryKeyStore["issue"]>[0]): Promise<boolean> {
    return this.enter() ?? super.issue(key);
  }
  override revoke(owner: string, now: number): Promise<boolean> {
    return this.enter() ?? super.revoke(owner, now);
  }

  /** How many sealed copies the store holds, to see that a revoke deletes one. */
  copyCount(): number {
    return (this as unknown as { copies: Map<string, Buffer> }).copies.size;
  }

  private enter<T>(): Promise<T> | undefined {
    this.calls += 1;
    return this.failing
      ? Promise.reject(new Error("connect ECONNREFUSED postgres://secret-user:secret-pass@db"))
      : undefined;
  }
}

/** The plans' names the operator gave, in memory, failing on request. */
export class TestPlans extends MemoryAccountPlanStore {
  failing = false;

  override planOf(owner: string): Promise<string | undefined> {
    return this.failing
      ? Promise.reject(new Error("connect ECONNREFUSED postgres://secret-user:secret-pass@db"))
      : super.planOf(owner);
  }
}

/** The payments counted per account, in memory, failing on request. */
export class TestUsage extends MemoryAccountUsage {
  failing = false;

  override paymentsSince(owner: string, since: number): Promise<number> {
    return this.failing
      ? Promise.reject(new Error("connect ECONNREFUSED postgres://secret-user:secret-pass@db"))
      : super.paymentsSince(owner, since);
  }
}

export interface Answer {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads whatever shape an answer has
  body: any;
}

export interface Portal {
  keys: TestStore;
  plans: TestPlans;
  usage: TestUsage;
  logs: { level: string; event: string; fields: Record<string, unknown> }[];
  /** Moves the clock the app and the tokens run on. */
  advance(ms: number): void;
  now(): number;
  /** A token as the hub signs one, at the portal's clock now. */
  token(act: Act, over?: { id?: string; claims?: Record<string, unknown> }): string;
  /** One call; `token` is sent as the bearer, `headers` are added. */
  call(
    method: string,
    path: string,
    init?: { token?: string; headers?: Record<string, string> },
  ): Promise<Answer>;
  /** The route for `act`, called with a token for `act` (or the given one). */
  hub(
    act: Act,
    init?: { token?: string; id?: string; headers?: Record<string, string> },
  ): Promise<Answer>;
}

export const ROUTES: Record<Act, { method: "GET" | "POST"; path: string }> = {
  read: { method: "GET", path: "/api/hub/v1/account" },
  reveal: { method: "POST", path: "/api/hub/v1/key/reveal" },
  revoke: { method: "POST", path: "/api/hub/v1/key/revoke" },
  issue: { method: "POST", path: "/api/hub/v1/key/issue" },
};

const servers: { close(): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** The app on a port of its own, on the registry in memory and a clock the test moves. */
export async function startPortal(
  overrides: Omit<Partial<AppDeps>, "config"> & { config?: Partial<AppDeps["config"]> } = {},
): Promise<Portal> {
  let now = NOW;
  const keys = new TestStore();
  const plans = new TestPlans();
  const usage = new TestUsage();
  const logs: Portal["logs"] = [];
  const log =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}) =>
      void logs.push({ level, event, fields });
  const logger: Logger = {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
  const { config, ...rest } = overrides;
  const app = createApp({
    config: {
      hubSecret: { current: SECRET },
      minAccountAgeMinutes: 5,
      clientIp: "socket",
      accountPlans: parseAccountPlans(DEFAULT_ACCOUNT_PLANS),
      ...config,
    },
    keys,
    plans,
    usage,
    sealer: sealer(ENCRYPTION_KEY),
    logger,
    ready: () => Promise.resolve(),
    now: () => now,
    ...rest,
  });
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const token: Portal["token"] = (act, over = {}) => {
    const iat = Math.floor(now / 1000);
    return signHubToken(SECRET, {
      iss: "https://sorobanscan.com/api/hub",
      aud: "x402",
      sub: `discord:${over.id ?? ACCOUNT_A}`,
      name: USERNAME,
      iat,
      exp: iat + 60,
      jti: `jti-${act}`,
      act,
      ...over.claims,
    });
  };
  const call: Portal["call"] = async (method, path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.token !== undefined) headers.set("authorization", `Bearer ${init.token}`);
    const response = await fetch(`${base}${path}`, { method, headers });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text === "" ? undefined : JSON.parse(text),
    };
  };
  return {
    keys,
    plans,
    usage,
    logs,
    advance: (ms) => void (now += ms),
    now: () => now,
    token,
    call,
    hub: (act, init = {}) =>
      call(ROUTES[act].method, ROUTES[act].path, {
        token: init.token ?? token(act, init.id === undefined ? {} : { id: init.id }),
        ...(init.headers && { headers: init.headers }),
      }),
  };
}
