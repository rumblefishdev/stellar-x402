import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Identifiers only: never secrets or full XDR (spine "Logging and metrics"). */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Bigints as decimal strings, errors with their name, message, stack and `Error` cause
 * (`JSON.stringify` drops all of them), each URL in them redacted as in {@link redactUrls}: an RPC
 * error's message can hold the URL, and the URL an API key. A stack adds code locations, not data:
 * its first line is the message.
 *
 * An error is recognized by the holder's original value: `JSON.stringify` calls `toJSON` before
 * the replacer, and the snapshot an AxiosError (stellar-sdk's RPC client) returns holds the
 * request body, i.e. a signed transaction's XDR.
 *
 * ponytail: one level of cause, so a cyclic chain can't recurse; walk the chain with a seen-set if
 * deeper causes turn out to matter.
 */
function replacerFor(redact: (text: string) => string) {
  return function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
    const original = this[key];
    if (original instanceof Error) return redactedError(original, redact);
    if (typeof value === "bigint") return value.toString();
    return value;
  };
}

/**
 * One JSON object per line on stdout, at `level` and above. `rpcUrls` are the configured
 * `RPC_URLS`, which {@link redactUrls} names instead of giving their host.
 *
 * ponytail: hand-rolled; switch to pino if the backend chosen in 0014 needs transports or redaction.
 */
export function jsonLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stdout.write(line),
  rpcUrls: readonly string[] = [],
): Logger {
  const replacer = replacerFor((text) => redactUrls(text, rpcUrls));
  const at =
    (logLevel: LogLevel) =>
    (event: string, fields: LogFields = {}) => {
      if (LEVELS.indexOf(logLevel) < LEVELS.indexOf(level)) return;
      // The envelope comes first and is spread again last, so no field can overwrite it.
      const envelope = { time: new Date().toISOString(), level: logLevel, event };
      let line: string;
      try {
        line = JSON.stringify({ ...envelope, ...fields, ...envelope }, replacer);
      } catch {
        // A cyclic or otherwise unserializable field. A log call must not throw: in the HTTP
        // error handler that would hand the error to Express, which answers with its stack.
        line = JSON.stringify({ ...envelope, fields: "unserializable" });
      }
      write(`${line}\n`);
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/**
 * How logs name `RPC_URLS[index]`: by index, never by URL or host (ADR 0011), plus the first 8 hex
 * digits of the entry's SHA-256. An RPC URL can carry an API key, and a host can be an account's own
 * endpoint name or an internal one. The fingerprint tells a line written before `RPC_URLS` changed
 * from one written after; `printf %s "$url" | sha256sum | cut -c1-8` matches it to a URL.
 */
export function rpcEndpointName(url: string, index: number): string {
  const fingerprint = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return `RPC_URLS[${index}]#${fingerprint}`;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Each URL in `text` redacted, so an API key stays out of the logs: a URL that starts with an entry
 * of `rpcUrls` becomes that entry's {@link rpcEndpointName}, one on an entry's host the names of
 * every entry on that host, and any other URL its host.
 */
export function redactUrls(text: string, rpcUrls: readonly string[] = []): string {
  return text.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, (url) => {
    const host = hostOf(url);
    if (host === undefined) return "[url]";
    let prefix = -1;
    rpcUrls.forEach((entry, index) => {
      if (url.startsWith(entry) && entry.length > (rpcUrls[prefix]?.length ?? 0)) prefix = index;
    });
    if (prefix >= 0) return rpcEndpointName(rpcUrls[prefix] ?? "", prefix);
    const sameHost = rpcUrls.flatMap((entry, index) =>
      hostOf(entry) === host ? [rpcEndpointName(entry, index)] : [],
    );
    return sameHost.length > 0 ? sameHost.join("|") : host;
  });
}

/** An error as its name, message and stack, URLs redacted, with one level of cause. */
function redactedError(error: Error, redact: (text: string) => string, depth = 0): LogFields {
  return {
    name: error.name,
    message: redact(String(error.message)),
    stack: error.stack === undefined ? undefined : redact(error.stack),
    cause:
      depth === 0 && error.cause instanceof Error
        ? redactedError(error.cause, redact, 1)
        : undefined,
  };
}

/** A non-error `console.error` argument as text: JSON when it can be, else `String`. */
function text(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    const json = JSON.stringify(arg);
    if (json !== undefined) return json;
  } catch {
    // A bigint or a cycle; `String` below.
  }
  return String(arg);
}

/**
 * Sends every `console.error` in the process through `logger`, as one `console_error` event at
 * error level. Upstream `@x402/stellar` writes its errors there, and the whole object of a failed
 * RPC call, an AxiosError, holds the request URL and body. So an error becomes its name, message,
 * stack and cause, other arguments become JSON or text, and every URL is redacted as in
 * {@link redactUrls} (an RPC URL can carry an API key, ADR 0011). Formatting never throws, as
 * `console.error` doesn't.
 * Returns the function that puts the original `console.error` back.
 */
export function captureConsoleError(logger: Logger, rpcUrls: readonly string[] = []): () => void {
  const redact = (text: string) => redactUrls(text, rpcUrls);
  const original = console.error;
  console.error = (...args: unknown[]) => {
    let fields: LogFields;
    try {
      const errors = args.filter((arg): arg is Error => arg instanceof Error);
      fields = {
        message: redact(
          args
            .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : text(arg)))
            .join(" "),
        ),
        errors: errors.length > 0 ? errors.map((error) => redactedError(error, redact)) : undefined,
      };
    } catch {
      fields = { message: "unformattable console.error arguments" };
    }
    logger.error("console_error", fields);
  };
  return () => {
    console.error = original;
  };
}
