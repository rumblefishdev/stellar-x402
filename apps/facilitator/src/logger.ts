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

const plain = ({ name, message, stack }: Error) => ({ name, message, stack });

/**
 * Bigints as decimal strings, errors with their name, message, stack and `Error` cause
 * (`JSON.stringify` drops all of them). A stack adds code locations, not data: its first line is
 * the message.
 *
 * An error is recognized by the holder's original value: `JSON.stringify` calls `toJSON` before
 * the replacer, and the snapshot an AxiosError (stellar-sdk's RPC client) returns holds the
 * request body, i.e. a signed transaction's XDR.
 *
 * ponytail: one level of cause, so a cyclic chain can't recurse; walk the chain with a seen-set if
 * deeper causes turn out to matter.
 */
function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const original = this[key];
  if (original instanceof Error)
    return {
      ...plain(original),
      cause: original.cause instanceof Error ? plain(original.cause) : undefined,
    };
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * One JSON object per line on stdout, at `level` and above.
 *
 * ponytail: hand-rolled; switch to pino if the backend chosen in 0014 needs transports or redaction.
 */
export function jsonLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stdout.write(line),
): Logger {
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

/** Each URL in `text` as its host only: an RPC URL can carry an API key (ADR 0011). */
export function redactUrls(text: string): string {
  return text.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      return new URL(url).host;
    } catch {
      return "[url]";
    }
  });
}

/** An error as its name, message and stack, URLs reduced to their host, with one level of cause. */
function redactedError(error: Error, depth = 0): LogFields {
  return {
    name: error.name,
    message: redactUrls(String(error.message)),
    stack: error.stack === undefined ? undefined : redactUrls(error.stack),
    cause: depth === 0 && error.cause instanceof Error ? redactedError(error.cause, 1) : undefined,
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
 * stack and cause, other arguments become JSON or text, and every URL keeps only its host (an RPC
 * URL can carry an API key, ADR 0011). Formatting never throws, as `console.error` doesn't.
 * Returns the function that puts the original `console.error` back.
 */
export function captureConsoleError(logger: Logger): () => void {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    let fields: LogFields;
    try {
      const errors = args.filter((arg): arg is Error => arg instanceof Error);
      fields = {
        message: redactUrls(
          args
            .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : text(arg)))
            .join(" "),
        ),
        errors: errors.length > 0 ? errors.map((error) => redactedError(error)) : undefined,
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
