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
