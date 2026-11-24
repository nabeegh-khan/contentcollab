// The health summary of the operations page (D35): four lines, each a word (OK, Check or Not measured) and a shape,
// so colour is never the only signal. Every number is computed from the snapshot; nothing is typed in.
import { ageText } from "./format.js";

const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3600 * MS_PER_SECOND;
const ROUND_TENTHS = 10;
const ERROR_CHECK_PERCENT = 1;
const P95_CHECK_SECONDS = 1;
// Prometheus returns the top bucket's bound when the quantile lies above it (D31)
const TOP_BUCKET_SECONDS = 5;

export const VIEWS = {
  ok: { word: "OK", shape: "●" },
  check: { word: "Check", shape: "▲" },
  unknown: { word: "Not measured", shape: "○" },
};

const isMissing = (value) => value === null || value === undefined;
const tenths = (value) => Math.round(value * ROUND_TENTHS) / ROUND_TENTHS;
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const line = (key, title, state, text) => ({ key, title, state, ...VIEWS[state], text });
const notAvailable = (key, title, reason) =>
  line(key, title, "unknown", `not available: ${reason ?? "no data"}`);

/** "8 ms", "1.3 s", "over 5 s": the slowest 5 percent, short enough for a one-line summary. */
export function p95Text(seconds) {
  if (seconds === null || seconds === undefined) return "not measured";
  if (seconds >= TOP_BUCKET_SECONDS) return "over 5 s";
  if (seconds < P95_CHECK_SECONDS) return `${Math.round(seconds * MS_PER_SECOND)} ms`;
  return `${tenths(seconds)} s`;
}

/** One row of the alerts table: OK up to the threshold, Over above it, Not measured without a value. */
export function alertStatus(valuePercent, thresholdPercent) {
  if (valuePercent === null || valuePercent === undefined)
    return { state: "unknown", ...VIEWS.unknown };
  return valuePercent > thresholdPercent
    ? { state: "check", word: "Over", shape: VIEWS.check.shape }
    : { state: "ok", ...VIEWS.ok };
}

/** "succeeded 14 h ago", "FAILED 2 min ago; last success 1 h ago", "running now", "no run yet". */
export function backupText(backup, nowMs) {
  const run = backup?.lastRun;
  const ago = (iso) =>
    `${ageText(Math.max(0, Math.round((nowMs - Date.parse(iso)) / MS_PER_SECOND)))} ago`;
  // No Job object is left (old ones are cleaned up), but the CronJob remembers its last success
  if (!run)
    return backup?.lastSucceededAt ? `succeeded ${ago(backup.lastSucceededAt)}` : "no run yet";
  if (run.result === "Running") return "running now";
  if (run.result === "Succeeded")
    return run.finishedAt ? `succeeded ${ago(run.finishedAt)}` : "succeeded";
  const failed = run.finishedAt ? `FAILED ${ago(run.finishedAt)}` : "FAILED";
  return backup.lastSucceededAt
    ? `${failed}; last success ${ago(backup.lastSucceededAt)}`
    : `${failed}; no success on record`;
}

function containersLine(data) {
  const rows = data.containers;
  if (!rows) return notAvailable("containers", "Containers", data.errors?.containers);
  const running = rows.filter((c) => c.status === "Running").length;
  const nodes = new Set(rows.map((c) => c.node).filter(Boolean)).size;
  const now = Date.parse(data.generatedAt);
  const restarted = rows.filter(
    (c) => c.lastRestartAt && now - Date.parse(c.lastRestartAt) <= MS_PER_HOUR,
  ).length;
  const restarts =
    restarted === 0
      ? "0 restarts in the last hour"
      : `${plural(restarted, "container", "containers")} restarted in the last hour`;
  const healthy = rows.length > 0 && running === rows.length && restarted === 0;
  return line(
    "containers",
    "Containers",
    healthy ? "ok" : "check",
    `${running} of ${rows.length} running on ${plural(nodes, "node", "nodes")}, ${restarts}`,
  );
}

function replicasLine(data) {
  const rows = data.workloads;
  if (!rows) return notAvailable("replicas", "Replicas", data.errors?.workloads);
  if (rows.length === 0) return notAvailable("replicas", "Replicas", "no workload found");
  const healthy = rows.every((w) => w.ready >= w.desired);
  return line(
    "replicas",
    "Replicas",
    healthy ? "ok" : "check",
    rows.map((w) => `${w.component} ${w.ready}/${w.desired}`).join(", "),
  );
}

function trafficLine(data) {
  const t = data.traffic;
  if (!t) return notAvailable("traffic", "Traffic", data.errors?.traffic);
  // A missing request series is not "no requests": zero is a measured rate, null is not
  if (t.requestsPerSecond === null || t.requestsPerSecond === undefined) {
    return line("traffic", "Traffic", "unknown", "not available: Prometheus has no request series");
  }
  const errors =
    t.errorPercent5m === null || t.errorPercent5m === undefined
      ? "no requests to count in the last 5 min"
      : `${tenths(t.errorPercent5m)}% errors in the last 5 min`;
  const text = t.noTraffic
    ? `no requests in the last minute, ${errors}`
    : `${tenths(t.requestsPerSecond)} requests/s, ${errors}, p95 ${p95Text(t.p95Seconds)}`;
  // With live traffic, a missing p95 or error figure means the line cannot say OK
  const missing = !t.noTraffic && (isMissing(t.p95Seconds) || isMissing(t.errorPercent5m));
  const bad =
    (t.errorPercent5m ?? 0) > ERROR_CHECK_PERCENT ||
    (!t.noTraffic && (t.p95Seconds ?? 0) >= P95_CHECK_SECONDS);
  const state = bad ? "check" : missing ? "unknown" : "ok";
  return line("traffic", "Traffic", state, text);
}

function diskLine(data) {
  const claim = data.storage?.claim;
  if (!claim) return notAvailable("disk", "Database disk", data.errors?.claim);
  const used = data.storage.diskUsedPercent;
  const measured = used !== null && used !== undefined;
  const usedText = measured ? `${Math.round(used)}% used` : "used space not measured";
  // The limit is the API's alert threshold (scripts/alerts.sh), not a copy kept here
  const limit = data.alerts?.thresholdPercent;
  const bad = claim.phase !== "Bound" || (measured && limit !== undefined && used > limit);
  // Only the claim is known when the used space is not: that is not "OK" for the disk
  const state = bad ? "check" : measured ? "ok" : "unknown";
  return line(
    "disk",
    "Database disk",
    state,
    `claim ${claim.name} ${claim.phase}, ${claim.capacity ?? "size unknown"}, ${usedText}`,
  );
}

/** The four lines at the top of the page. */
export function healthLines(data) {
  return [containersLine(data), replicasLine(data), trafficLine(data), diskLine(data)];
}
