// One rule for the URLs the stacks and the off-server check read: the config checks them at synth,
// and the check's Lambda again at its start, so a URL one accepts the other can't refuse.

/** An `https:` URL with a dotted host, as `new URL` parses it (so `HTTPS://` counts too). */
export function isHttpsUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}
