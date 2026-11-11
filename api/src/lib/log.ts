// One JSON object per line on standard output (OBS-1, ARCHITECTURE D16).
// Key names follow Datadog: `timestamp` is read as the log's date, `msg` as
// its message and `level` as its status. Nothing is written except what the
// caller passes in, so a log line never carries a header, cookie or body.

export type Level = "debug" | "info" | "warn" | "error";

// Lowest to highest: a line is written when its level is at or above the threshold
const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];
const DEFAULT_LEVEL: Level = "info";

// Read on every call, so a test (or an operator restarting with a new value)
// changes it without a rebuild; an unknown value falls back to info.
function threshold(): Level {
  const wanted = LEVELS.find((level) => level === process.env.LOG_LEVEL);
  return wanted ?? DEFAULT_LEVEL;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(threshold())) return;
  const line = { timestamp: new Date().toISOString(), level, msg, ...fields };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// Datadog's standard error attributes: error.kind, error.message, error.stack
export function errorFields(err: unknown): { kind: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { kind: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { kind: "NonError", message: String(err) };
}
