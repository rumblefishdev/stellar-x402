// Errors from the check's endpoints (an RPC, Horizon), for the log and the run's error: without the
// URL, where a provider's key can sit, named by the network instead.

/**
 * The forms of an endpoint's URL an error can quote: as configured, as `new URL` writes it back (a
 * client prints that one: lower-case scheme and host, a default port dropped), and its path and
 * query alone, where a provider's key sits. Longest first, so a whole URL goes before its parts.
 */
function urlForms(url: string): string[] {
  const forms = new Set([url]);
  try {
    const u = new URL(url);
    forms.add(u.href);
    forms.add(`${u.host}${u.pathname}${u.search}`);
    if (u.pathname.length > 1) forms.add(u.pathname);
    if (u.search) forms.add(u.search);
  } catch {
    // The targets' parsers refuse a URL that doesn't parse.
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * An error's text without the endpoint's URL: a provider's key can sit in it on mainnet (0009's
 * endpoint naming), and the log writes `name`, such as `rpc(stellar:testnet)`, instead.
 */
export function describeError(error: unknown, url: string, name: string): string {
  const e = error as { name?: string; message?: string } | undefined;
  let text = `${e?.name ?? "Error"}: ${e?.message ?? String(error)}`;
  for (const form of urlForms(url)) text = text.split(form).join(name);
  return text;
}
