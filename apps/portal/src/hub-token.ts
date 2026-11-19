import { createHmac, timingSafeEqual } from "node:crypto";
import type { HubSecret } from "./config.js";

export const ACTS = ["read", "reveal", "revoke", "issue"] as const;
export type Act = (typeof ACTS)[number];

export interface HubCaller {
  discordId: string;
  jti: string;
  act: Act;
}

const ISSUER = "https://sorobanscan.com/api/hub";
const AUDIENCE = "x402";
/**
 * Part of what the MAC covers, so a token the hub signed for another product can't pass here
 * even though it shares the secret and the claims.
 */
const CONTEXT = Buffer.from("sorobanscan-hub/x402-token/v1");
/** Real tokens are about 300 characters; the cap keeps an oversized one from costing an HMAC. */
const MAX_TOKEN_LENGTH = 2048;
/** A token lives 60 seconds; the hub's clock and ours may differ by a few. */
const MAX_LIFETIME_S = 60;
const SKEW_MS = 5_000;
const MAX_JTI_LENGTH = 64;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const SUBJECT = /^discord:([0-9]{1,20})$/;

/** Bytes of a base64url string that is exactly what encoding those bytes gives, else undefined. */
function decodeCanonical(text: string): Buffer | undefined {
  if (!BASE64URL.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64url");
  // Padding, stray bits in the last character and the like re-encode to something else: one
  // token, one spelling.
  return bytes.toString("base64url") === text ? bytes : undefined;
}

function mac(secret: Buffer, payload: string): Buffer {
  return createHmac("sha256", secret)
    .update(Buffer.concat([CONTEXT, Buffer.from([0]), Buffer.from(payload, "ascii")]))
    .digest();
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** The caller a token names, or `undefined` for any token that isn't the hub's for x402, now. */
export function verifyHubToken(
  token: string,
  secret: HubSecret,
  nowMs: number,
): HubCaller | undefined {
  try {
    // A comparison with NaN is false both ways, so a time check written as a refusal would let
    // every token through: with no clock there is nothing to hold a token to.
    if (!Number.isFinite(nowMs)) return undefined;
    if (token.length > MAX_TOKEN_LENGTH) return undefined;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return undefined;
    const [, payload, macText] = parts as [string, string, string];
    const given = decodeCanonical(macText);
    if (given === undefined || given.length !== 32) return undefined;
    // The MAC reads the payload as ASCII, which keeps only each character's low byte: a
    // look-alike outside base64url could carry the original MAC, so the characters are checked first.
    if (!BASE64URL.test(payload)) return undefined;

    // Both keys' MACs are always computed and compared, so the time taken doesn't say which
    // key, if any, the token was signed with.
    const keys = [secret.current, secret.previous ?? secret.current];
    let holds = false;
    for (const key of keys) {
      if (timingSafeEqual(given, mac(key, payload))) holds = true;
    }
    if (!holds) return undefined;

    // Only a token the hub signed gets its claims read.
    const json = decodeCanonical(payload);
    if (json === undefined) return undefined;
    const claims: unknown = JSON.parse(json.toString("utf8"));
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return undefined;
    const c = claims as Record<string, unknown>;

    if (c.iss !== ISSUER || c.aud !== AUDIENCE) return undefined;
    if (typeof c.sub !== "string") return undefined;
    const subject = SUBJECT.exec(c.sub);
    if (subject === null) return undefined;
    if (typeof c.act !== "string" || !(ACTS as readonly string[]).includes(c.act)) return undefined;
    if (typeof c.jti !== "string" || c.jti.length === 0 || c.jti.length > MAX_JTI_LENGTH)
      return undefined;
    if (!isInteger(c.iat) || !isInteger(c.exp)) return undefined;
    if (c.exp < c.iat || c.exp - c.iat > MAX_LIFETIME_S) return undefined;
    if (c.exp * 1000 <= nowMs - SKEW_MS) return undefined;
    if (c.iat * 1000 > nowMs + SKEW_MS) return undefined;

    return { discordId: subject[1] as string, jti: c.jti, act: c.act as Act };
  } catch {
    return undefined;
  }
}

/** For tests and the runbook's probe only: a token as the hub signs one. */
export function signHubToken(secret: Buffer, claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `v1.${payload}.${mac(secret, payload).toString("base64url")}`;
}
