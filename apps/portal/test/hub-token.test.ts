import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signHubToken, verifyHubToken } from "../src/hub-token.js";

const SECRET = Buffer.from("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=", "base64");
const OTHER = Buffer.alloc(32, 9);
const NOW = 1_795_000_030_000;
const NOW_S = NOW / 1000;

const PINNED_CLAIMS = `{"iss":"https://sorobanscan.com/api/hub","aud":"x402","sub":"discord:80351110224678912","name":"nelly","iat":1795000000,"exp":1795000060,"jti":"AAECAwQFBgcICQoLDA0ODw","act":"reveal"}`;
const PINNED_TOKEN =
  "v1.eyJpc3MiOiJodHRwczovL3Nvcm9iYW5zY2FuLmNvbS9hcGkvaHViIiwiYXVkIjoieDQwMiIsInN1YiI6ImRpc2NvcmQ6ODAzNTExMTAyMjQ2Nzg5MTIiLCJuYW1lIjoibmVsbHkiLCJpYXQiOjE3OTUwMDAwMDAsImV4cCI6MTc5NTAwMDA2MCwianRpIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EdyIsImFjdCI6InJldmVhbCJ9.mpP3cY6Kclck-SvWeTU6bYt9xnTiVNmx91xl6L1Qkho";
// The other product's token: the same secret and claims, `aud: "prices"`, its own context.
const PRICES_TOKEN =
  "v1.eyJpc3MiOiJodHRwczovL3Nvcm9iYW5zY2FuLmNvbS9hcGkvaHViIiwiYXVkIjoicHJpY2VzIiwic3ViIjoiZGlzY29yZDo4MDM1MTExMDIyNDY3ODkxMiIsIm5hbWUiOiJuZWxseSIsImlhdCI6MTc5NTAwMDAwMCwiZXhwIjoxNzk1MDAwMDYwLCJqdGkiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3IiwiYWN0IjoicmV2ZWFsIn0.aeS9_nACshTGuf2Afv4wbQhvLR-f64XCX0OVmmngofE";

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "https://sorobanscan.com/api/hub",
  aud: "x402",
  sub: "discord:80351110224678912",
  name: "nelly",
  iat: NOW_S - 10,
  exp: NOW_S + 50,
  jti: "AAECAwQFBgcICQoLDA0ODw",
  act: "reveal",
  ...over,
});
const without = (key: string): Record<string, unknown> => {
  const c = claims();
  delete c[key];
  return c;
};
const verify = (token: string) => verifyHubToken(token, { current: SECRET }, NOW);
const b64 = (s: string) => Buffer.from(s).toString("base64url");
/** A token whose MAC holds over an arbitrary payload string, for payloads that aren't claims. */
const signedPayload = (payload: string, context = "sorobanscan-hub/x402-token/v1") =>
  `v1.${payload}.${createHmac("sha256", SECRET)
    .update(Buffer.concat([Buffer.from(context), Buffer.from([0]), Buffer.from(payload)]))
    .digest("base64url")}`;

describe("the hub's token", () => {
  it("verifies the pinned vector the hub pins too", () => {
    expect(signHubToken(SECRET, JSON.parse(PINNED_CLAIMS))).toBe(PINNED_TOKEN);
    expect(verify(PINNED_TOKEN)).toEqual({
      discordId: "80351110224678912",
      jti: "AAECAwQFBgcICQoLDA0ODw",
      act: "reveal",
    });
  });

  it("refuses the other product's token, and an x402 token signed under its context", () => {
    expect(verify(PRICES_TOKEN)).toBeUndefined();
    const payload = b64(JSON.stringify(claims()));
    expect(verify(signedPayload(payload))).toBeDefined();
    expect(verify(signedPayload(payload, "sorobanscan-hub/prices-token/v1"))).toBeUndefined();
  });

  it("takes a token under `previous` while the secret rotates, and under neither otherwise", () => {
    const token = signHubToken(SECRET, claims());
    expect(verifyHubToken(token, { current: OTHER, previous: SECRET }, NOW)).toBeDefined();
    expect(verifyHubToken(token, { current: SECRET, previous: OTHER }, NOW)).toBeDefined();
    expect(verifyHubToken(token, { current: OTHER }, NOW)).toBeUndefined();
    expect(
      verifyHubToken(token, { current: OTHER, previous: Buffer.alloc(32, 8) }, NOW),
    ).toBeUndefined();
  });

  it("refuses a token of the wrong shape", () => {
    const good = signHubToken(SECRET, claims());
    const [, payload, mac] = good.split(".") as [string, string, string];
    expect(verify(good)).toBeDefined();
    expect(verify(`v2.${payload}.${mac}`)).toBeUndefined();
    expect(verify(`${payload}.${mac}`)).toBeUndefined();
    expect(verify(`v1.${payload}`)).toBeUndefined();
    expect(verify(`v1.${payload}.${mac}.x`)).toBeUndefined();
    expect(verify("")).toBeUndefined();
    expect(verify("v1..")).toBeUndefined();
    expect(verify(`v1.${payload}.${mac.slice(0, -2)}`)).toBeUndefined();
    expect(verify(`v1.${payload}.${mac}AA`)).toBeUndefined();
  });

  it("refuses a payload that isn't canonical base64url of a JSON object, even with a valid MAC", () => {
    const json = JSON.stringify(claims());
    expect(verify(signedPayload(b64(json)))).toBeDefined();
    // "??>" is "Pz8+" in standard base64 and "Pz8-" in base64url.
    const plus = JSON.stringify(claims({ name: "??>" }));
    expect(verify(signedPayload(b64(plus)))).toBeDefined();
    const std = Buffer.from(plus).toString("base64").replace(/=+$/, "");
    expect(std).toContain("+");
    expect(verify(signedPayload(std))).toBeUndefined();
    expect(verify(signedPayload(`${b64(json)}=`))).toBeUndefined();
    expect(verify(signedPayload(b64("not json")))).toBeUndefined();
    expect(verify(signedPayload("!!!!"))).toBeUndefined();
    expect(verify(signedPayload(b64("[1,2]")))).toBeUndefined();
    expect(verify(signedPayload(b64("null")))).toBeUndefined();
    expect(verify(signedPayload(b64('"x"')))).toBeUndefined();
    // A payload whose last character carries bits the bytes don't use re-encodes to something else.
    const odd = [0, 1, 2]
      .map((pad) => JSON.stringify(claims({ name: "n".repeat(pad) })))
      .find((text) => Buffer.byteLength(text) % 3 === 1) as string;
    const exact = b64(odd);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sloppy = exact.slice(0, -1) + alphabet[alphabet.indexOf(exact.slice(-1)) | 1];
    expect(sloppy).not.toBe(exact);
    expect(Buffer.from(sloppy, "base64url").toString()).toBe(odd);
    expect(verify(signedPayload(exact))).toBeDefined();
    expect(verify(signedPayload(sloppy))).toBeUndefined();
  });

  it("refuses a token with one bit of its MAC or payload changed", () => {
    const [prefix, payload, mac] = signHubToken(SECRET, claims()).split(".") as [
      string,
      string,
      string,
    ];
    const flip = (s: string, at: number) => {
      const bytes = Buffer.from(s, "base64url");
      bytes[at] = (bytes[at] ?? 0) ^ 1;
      return bytes.toString("base64url");
    };
    expect(verify(`${prefix}.${payload}.${flip(mac, 0)}`)).toBeUndefined();
    expect(verify(`${prefix}.${payload}.${flip(mac, 31)}`)).toBeUndefined();
    expect(verify(`${prefix}.${flip(payload, 5)}.${mac}`)).toBeUndefined();
  });

  it("refuses claims that aren't the hub's for x402", () => {
    const refused = (c: Record<string, unknown>) =>
      expect(verify(signHubToken(SECRET, c))).toBeUndefined();
    refused(claims({ iss: "https://sorobanscan.com/api/hub/" }));
    refused(without("iss"));
    refused(claims({ aud: "prices" }));
    refused(claims({ aud: ["x402"] }));
    refused(without("aud"));
    for (const sub of [
      "discord:abc",
      "discord:",
      "operator:x",
      `discord:${"1".repeat(21)}`,
      "discord:1a",
      " discord:1",
      5,
    ]) {
      refused(claims({ sub }));
    }
    refused(without("sub"));
    refused(claims({ act: "admin" }));
    refused(without("act"));
    refused(claims({ jti: "" }));
    refused(claims({ jti: "j".repeat(65) }));
    refused(claims({ jti: 7 }));
    refused(without("jti"));
    refused(claims({ iat: NOW_S - 10.5 }));
    refused(claims({ iat: String(NOW_S - 10) }));
    refused(without("iat"));
    refused(claims({ exp: NOW_S + 50.5 }));
    refused(claims({ exp: null }));
    refused(without("exp"));
  });

  it("takes each act, a 20-digit subject and a 64-character jti", () => {
    for (const act of ["read", "reveal", "revoke", "issue"]) {
      expect(verify(signHubToken(SECRET, claims({ act })))?.act).toBe(act);
    }
    const c = claims({ sub: `discord:${"9".repeat(20)}`, jti: "j".repeat(64) });
    expect(verify(signHubToken(SECRET, c))).toEqual({
      discordId: "9".repeat(20),
      jti: "j".repeat(64),
      act: "reveal",
    });
  });

  it("holds a token to its time", () => {
    const at = (over: Record<string, unknown>, nowMs = NOW) =>
      verifyHubToken(signHubToken(SECRET, claims(over)), { current: SECRET }, nowMs);
    // Expired five seconds ago is refused; four seconds ago still passes (clock skew).
    expect(at({ iat: NOW_S - 65, exp: NOW_S - 5 })).toBeUndefined();
    expect(at({ iat: NOW_S - 64, exp: NOW_S - 4 })).toBeDefined();
    // Issued five seconds ahead passes; a moment more does not.
    expect(at({ iat: NOW_S + 5, exp: NOW_S + 65 })).toBeDefined();
    expect(at({ iat: NOW_S + 5, exp: NOW_S + 65 }, NOW - 1)).toBeUndefined();
    // At most 60 seconds of life, and never before it began.
    expect(at({ iat: NOW_S, exp: NOW_S + 60 })).toBeDefined();
    expect(at({ iat: NOW_S, exp: NOW_S + 61 })).toBeUndefined();
    expect(at({ iat: NOW_S, exp: NOW_S - 1 })).toBeUndefined();
  });

  it("refuses every token when the clock isn't a number", () => {
    const token = signHubToken(SECRET, claims());
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(verifyHubToken(token, { current: SECRET }, bad)).toBeUndefined();
    }
  });

  it("refuses a payload with a non-ASCII look-alike, which the MAC's ASCII conversion would fold", () => {
    const [prefix, payload, mac] = signHubToken(SECRET, claims()).split(".") as [
      string,
      string,
      string,
    ];
    // U+0100 plus a character's code keeps only that character's low byte once read as ASCII.
    const folded = String.fromCharCode(0x100 + payload.charCodeAt(0)) + payload.slice(1);
    expect(Buffer.from(folded, "ascii").equals(Buffer.from(payload, "ascii"))).toBe(true);
    expect(verify(`${prefix}.${folded}.${mac}`)).toBeUndefined();
  });

  it("refuses a canonical MAC of 31 bytes, one byte short of the 32 an HMAC-SHA256 has", () => {
    const [prefix, payload, mac] = signHubToken(SECRET, claims()).split(".") as [
      string,
      string,
      string,
    ];
    const short = Buffer.from(mac, "base64url").subarray(0, 31).toString("base64url");
    expect(short).toHaveLength(42);
    expect(verify(`${prefix}.${payload}.${short}`)).toBeUndefined();
  });

  it("refuses a token longer than 2048 characters before it computes a MAC", () => {
    const long = signHubToken(SECRET, claims({ name: "n".repeat(2000) }));
    expect(long.length).toBeGreaterThan(2048);
    expect(verify(long)).toBeUndefined();
    // Even one with the right MAC: the length is the first gate.
    const ok = signHubToken(SECRET, claims({ name: "n".repeat(1200) }));
    expect(ok.length).toBeLessThanOrEqual(2048);
    expect(verify(ok)).toBeDefined();
  });

  it("never throws, whatever the string", () => {
    for (const s of [
      "v1.",
      "v1..",
      "...",
      "v1.\u0000.\u0000",
      "v1.é.é",
      "💥",
      "v1.e30.",
      `v1.${b64("{}")}.${"A".repeat(43)}`,
    ]) {
      expect(() => verify(s)).not.toThrow();
      expect(verify(s)).toBeUndefined();
    }
  });
});
