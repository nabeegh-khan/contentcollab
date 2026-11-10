// Pure helpers for loadtest.mjs: settings, why a request failed, per-step summaries, and the node-memory guard (#69).

/** A positive finite number, or undefined. */
const positive = (text) => {
  const n = Number(text);
  return String(text).trim() !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * The run's settings from the environment, or the first bad variable by name.
 * A bad value stops the run instead of producing NaN rows or sending nothing.
 * @returns {{config?: object, error?: string}}
 */
export function readConfig(env) {
  const steps = (env.STEPS ?? "10,25,50,100,200").split(",").map(positive);
  if (steps.some((s) => s === undefined)) return { error: `STEPS must be positive numbers separated by commas, got "${env.STEPS}"` };
  const named = [
    ["stepSeconds", "STEP_SECONDS", 60],
    ["timeoutMs", "TIMEOUT_MS", 5000],
    ["alignWindowS", "ALIGN_WINDOW_S", 30],
    ["maxNodeMemoryPct", "MAX_NODE_MEMORY_PCT", 95],
  ];
  const config = { steps };
  for (const [key, name, fallback] of named) {
    const value = positive(env[name] ?? fallback);
    if (value === undefined) return { error: `${name} must be a positive number, got "${env[name]}"` };
    config[key] = value;
  }
  if (config.maxNodeMemoryPct > 100) {
    return { error: `MAX_NODE_MEMORY_PCT must be a number from 1 to 100, got "${env.MAX_NODE_MEMORY_PCT}"` };
  }
  return { config };
}

/** Nearest-rank percentile of an ascending array; 0 when empty. */
export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * One step's row. sentPerS is the offered load the client kept up; okPerS counts only
 * successful responses, which is what the server actually served. Latency percentiles
 * come from successes only, so instant refusals and timeouts do not move them.
 */
export function summarizeStep({ target, sendSeconds, okLatencies, ok, fail, byReason }) {
  const total = ok + fail;
  const perS = (n) => (sendSeconds > 0 ? n / sendSeconds : 0).toFixed(1);
  const sorted = [...okLatencies].sort((a, b) => a - b);
  return {
    target,
    sentPerS: perS(total),
    okPerS: perS(ok),
    p50: percentile(sorted, 50).toFixed(0),
    p95: percentile(sorted, 95).toFixed(0),
    errors: total ? ((100 * fail) / total).toFixed(2) : "0.00",
    failed: fail,
    failures: summarizeFailures(byReason),
  };
}

/**
 * Why a request failed, or null if it did not. Any 4xx or 5xx is a failure: under
 * load a 408 or 429 is a refused request, and a 404 means TARGET_PATH is wrong.
 * @param {{status: number}|null} res the fetch response, if one arrived
 * @param {unknown} [err] what fetch threw, if it threw
 */
export function failureReason(res, err) {
  if (err !== undefined && err !== null) {
    if (err?.name === "TimeoutError") return "timeout"; // AbortSignal.timeout
    const code = [err?.cause?.code, err?.code].find((c) => typeof c === "string"); // DOMException.code is a number
    return clean(code ?? (err?.cause?.message || undefined) ?? (err instanceof Error ? err.name : "error"));
  }
  return res && res.status >= 400 ? `http ${res.status}` : null;
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
