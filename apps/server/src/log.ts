/**
 * Structured logging.
 *
 * One line per event, human-readable but machine-parseable:
 *
 *   21:04:11.123 INFO  [doctor] postgres reachable {"host":"localhost","port":5432}
 *
 * Everything goes to **stderr**, so stdout stays clean for real command output
 * (tables, JSON) that users may want to pipe elsewhere.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVEL_ORDER ? (raw as LogLevel) : "info";
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel) => (msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    process.stderr.write(`${timestamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${suffix}\n`);
  };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}
