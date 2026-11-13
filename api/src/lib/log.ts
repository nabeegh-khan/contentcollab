// One JSON object per line on standard output (OBS-1, ARCHITECTURE D16).
// Key names follow Datadog: `timestamp` is read as the log's date, `msg` as
// its message and `level` as its status. Nothing is written except what the
// caller passes in, so a log line never carries a header, cookie or body.

export type Level = "debug" | "info" | "warn" | "error";

// Lowest to highest: a line is written when its level is at or above the threshold
const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];
const DEFAULT_LEVEL: Level = "info";

// Unknown LOG_LEVEL values already reported, so each is named once, not on every line
const reported = new Set<string>();

function write(level: Level, msg: string, fields: Record<string, unknown>): void {
  const line = { timestamp: new Date().toISOString(), level, msg, ...fields };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// Read on every call, so a test (or an operator restarting with a new value)
// changes it without a rebuild. Any case is accepted ("DEBUG"); an unknown
// value falls back to info and is named once in a warn line, so an operator
// who mistyped it is told instead of silently getting info.
function threshold(): Level {
  const raw = process.env.LOG_LEVEL;
  if (raw === undefined || raw === "") return DEFAULT_LEVEL;
  const wanted = LEVELS.find((level) => level === raw.trim().toLowerCase());
  if (wanted) return wanted;
  if (!reported.has(raw)) {
    reported.add(raw);
    write("warn", "unknown LOG_LEVEL, using info", { log_level: raw });
  }
  return DEFAULT_LEVEL;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(threshold())) return;
  write(level, msg, fields);
}

// String() throws on some values (an object with no prototype); the log line
// must still be written, so such a value is named rather than printed
function printable(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "(unprintable value)";
  }
}

// Datadog's standard error attributes: error.kind, error.message, error.stack
export function errorFields(err: unknown): { kind: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { kind: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { kind: "NonError", message: printable(err) };
}
