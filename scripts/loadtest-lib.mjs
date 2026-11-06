// Pure helpers for loadtest.mjs: why a request failed, a per-step failure summary, and the node-memory guard (#69).

/**
 * Why a request failed, or null if it did not. A response below 500 is not a failure.
 * @param {{status: number}|null} res the fetch response, if one arrived
 * @param {unknown} [err] what fetch threw, if it threw
 */
export function failureReason(res, err) {
  if (err !== undefined && err !== null) {
    if (err?.name === "TimeoutError") return "timeout"; // AbortSignal.timeout
    return err?.cause?.code ?? err?.code ?? (err?.cause?.message || undefined) ?? err?.name ?? "error";
  }
  return res && res.status >= 500 ? `http ${res.status}` : null;
}

/** "http 503:5 timeout:3", most frequent first; "" when nothing failed. */
export function summarizeFailures(byReason) {
  return Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason}:${n}`)
    .join(" ");
}

/** Node name and memory % from `kubectl top nodes --no-headers` (NAME CPU CPU% MEMORY MEMORY%). */
export function parseTopNodes(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 5 && cols[4].endsWith("%"))
    .map((cols) => ({ node: cols[0], memoryPct: Number.parseInt(cols[4], 10) }));
}

/** The first node above the limit, or null. */
export function overMemory(nodes, limitPct) {
  return nodes.find((n) => n.memoryPct > limitPct) ?? null;
}
