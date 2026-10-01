/**
 * Structured logging.
 *
 * Emits one JSON object per line with a stable field set so the activity
 * timeline, the event log and stdout can be correlated on `correlationId`.
 * Secrets are redacted structurally (by key name), not by hoping no one logs
 * one by accident.
 */
import { getConfig } from "./config.js";

export const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

export interface LogContext {
  correlationId?: string;
  actorType?: string;
  actorId?: string;
  actorName?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  result?: string;
  [key: string]: unknown;
}

export interface LogRecord extends LogContext {
  level: LogLevel;
  message: string;
  timestamp: string;
  error?: { name: string; message: string; stack?: string };
}

const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|apikey|api_key|authorization|credential|privatekey|private_key|session)/i;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return output;
  }
  if (typeof value === "string" && value.length > 2000) {
    return `${value.slice(0, 2000)}...[truncated]`;
  }
  return value;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bound: LogContext): Logger;
}

function write(level: LogLevel, message: string, context: LogContext = {}): void {
  const config = getConfig();
  const threshold = LOG_LEVELS[config.logLevel];
  if (LOG_LEVELS[level] < threshold) return;

  const record: LogRecord = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(redact(context) as LogContext),
  };
  const error = context.error;
  if (error instanceof Error) {
    record.error = { name: error.name, message: error.message, stack: error.stack };
  }

  // Pretty single-line form in development, strict JSON everywhere else so log
  // shippers never have to guess.
  if (config.env === "development") {
    const { timestamp, level: lvl, message: msg, ...rest } = record;
    const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
    const line = `${timestamp} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}`;
    if (lvl === "error") console.error(line);
    else if (lvl === "warn") console.warn(line);
    // eslint-disable-next-line no-console
    else console.log(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

export function createLogger(bound: LogContext = {}): Logger {
  return {
    debug: (message, context) => write("debug", message, { ...bound, ...context }),
    info: (message, context) => write("info", message, { ...bound, ...context }),
    warn: (message, context) => write("warn", message, { ...bound, ...context }),
    error: (message, context) => write("error", message, { ...bound, ...context }),
    child: (extra) => createLogger({ ...bound, ...extra }),
  };
}

export const logger = createLogger();

/** `true` when a log line may contain sensitive material. */
export function isSensitive(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export { REDACTED };
