import type { LogLevel } from "./config.js";

/** Identifiers only: never a key, a token, a secret or a database URL. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** An error as JSON keeps its name, message, stack and one level of cause, which it otherwise drops. */
function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const original = this[key];
  if (!(original instanceof Error)) return value;
  const { cause } = original;
  return {
    name: original.name,
    message: original.message,
    stack: original.stack,
    ...(cause instanceof Error && { cause: { name: cause.name, message: cause.message } }),
  };
}

/** One JSON object per line on stdout, at `level` and above. */
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
        line = JSON.stringify({ ...envelope, unloggable: true });
      }
      write(`${line}\n`);
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
