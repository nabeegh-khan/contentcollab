// Pure helpers for loadtest.mjs: why a request failed, a per-step failure summary, and the node-memory guard (#69).

/**
 * Why a request failed, or null if it did not. A response below 500 is not a failure.
 * @param {{status: number}|null} res the fetch response, if one arrived
 * @param {unknown} [err] what fetch threw, if it threw
 */
export function failureReason(res, err) {
  if (err !== undefined && err !== null) {
    if (err?.name === "TimeoutError") return "timeout"; // AbortSignal.timeout
    const code = [err?.cause?.code, err?.code].find((c) => typeof c === "string"); // DOMException.code is a number
    return clean(code ?? (err?.cause?.message || undefined) ?? (err instanceof Error ? err.name : "error"));
  }
  return res && res.status >= 500 ? `http ${res.status}` : null;
}

/** A reason is written into a CSV cell: no commas, quotes or newlines, at most 60 characters. */
const clean = (reason) => String(reason).replace(/[,\r\n"]/g, " ").slice(0, 60);

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

/**
 * Turns timed samples of {desired, replicas, ready} into changes: pods added or
 * removed (Deployment replicas) and pods turning ready (readyReplicas going up).
 */
export function scalingChanges(samples) {
  const changes = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (b.replicas > a.replicas) changes.push({ t: b.t, kind: "added", from: a.replicas, to: b.replicas });
    if (b.replicas < a.replicas) changes.push({ t: b.t, kind: "removed", from: a.replicas, to: b.replicas });
    if (b.ready > a.ready) changes.push({ t: b.t, kind: "ready", from: a.ready, to: b.ready });
  }
  return changes;
}

/**
 * For each failure time (ms), the seconds since the latest pod was added or turned
 * ready (null if none yet), and how many fall within windowMs after such a change.
 */
export function alignFailures(failureTimes, changes, windowMs) {
  const ups = changes.filter((c) => c.kind === "added" || c.kind === "ready").map((c) => c.t);
  const secondsAfter = failureTimes.map((f) => {
    const before = ups.filter((t) => t <= f);
    return before.length ? (f - Math.max(...before)) / 1000 : null;
  });
  return {
    total: failureTimes.length,
    inWindow: secondsAfter.filter((s) => s !== null && s * 1000 <= windowMs).length,
    beforeAnyChange: secondsAfter.filter((s) => s === null).length,
    secondsAfter,
  };
}
