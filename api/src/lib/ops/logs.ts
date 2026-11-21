// The log card (D31): a few request lines, only from fixed fields. Anything else is counted, never shown.
const MAX_LINES = 20;
const MAX_VALUE = 200;
const OWN_ROUTES = ["/api/v1/ops", "/api/v1/status"];

export interface LogLine {
  at: string;
  pod: string;
  level: string;
  msg: string;
  method: string | null;
  route: string | null;
  status: number | null;
  durationMs: number | null;
}

const cut = (value: unknown): string | null =>
  typeof value === "string" ? value.slice(0, MAX_VALUE) : null;
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

function parse(pod: string, line: string): LogLine | "hidden" | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return "hidden";
  }
  if (typeof raw !== "object" || raw === null) return "hidden";
  const o = raw as Record<string, unknown>;
  const http = (typeof o.http === "object" && o.http !== null ? o.http : {}) as Record<
    string,
    unknown
  >;
  const route = cut(http.route);
  if (route && OWN_ROUTES.some((own) => route === own || route.startsWith(`${own}/`))) return null;
  // Only request lines: another line's text can hold an address or a driver message (a Redis outage line)
  if (o.msg !== "request") return "hidden";
  const at = cut(o.timestamp);
  if (!at) return "hidden";
  return {
    at,
    pod,
    level: cut(o.level) ?? "info",
    msg: cut(o.msg) ?? "",
    method: cut(http.method),
    route,
    status: num(http.status_code),
    durationMs: num(o.duration_ms),
  };
}

/** The newest 20 request lines of all pods, oldest first, and how many lines were not shown as JSON. */
export function logLinesFrom(entries: { pod: string; text: string }[]): {
  lines: LogLine[];
  hidden: number;
} {
  const parsed = entries.flatMap(({ pod, text }) =>
    text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => parse(pod, line)),
  );
  const lines = parsed.filter((p): p is LogLine => p !== null && p !== "hidden");
  lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { lines: lines.slice(-MAX_LINES), hidden: parsed.filter((p) => p === "hidden").length };
}
