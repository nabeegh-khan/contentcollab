// The health summary of the operations page (D35): four lines, each a word (OK, Check or Not measured) and a shape,
// so colour is never the only signal. Every number is computed from the snapshot; nothing is typed in.
import { ageText } from "./format.js";

const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3600 * MS_PER_SECOND;
const ROUND_TENTHS = 10;
const ERROR_CHECK_PERCENT = 1;
const P95_CHECK_SECONDS = 1;
// The page's own limit for a full disk is the one of the DigitalOcean alert policies (scripts/alerts.sh)
const DISK_CHECK_PERCENT = 80;
// Prometheus returns the top bucket's bound when the quantile lies above it (D31)
const TOP_BUCKET_SECONDS = 5;

export const VIEWS = {
  ok: { word: "OK", shape: "●" },
  check: { word: "Check", shape: "▲" },
  unknown: { word: "Not measured", shape: "○" },
};

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
  if (!run) return "no run yet";
  const ago = (iso) =>
    `${ageText(Math.max(0, Math.round((nowMs - Date.parse(iso)) / MS_PER_SECOND)))} ago`;
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
  const healthy = rows.length > 0 && rows.every((w) => w.ready >= w.desired);
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
  const errors =
    t.errorPercent5m === null || t.errorPercent5m === undefined
      ? "no requests to count in the last 5 min"
      : `${tenths(t.errorPercent5m)}% errors in the last 5 min`;
  const text = t.noTraffic
    ? `no requests in the last minute, ${errors}`
    : `${tenths(t.requestsPerSecond)} requests/s, ${errors}, p95 ${p95Text(t.p95Seconds)}`;
  const bad =
    (t.errorPercent5m ?? 0) > ERROR_CHECK_PERCENT ||
    (!t.noTraffic && (t.p95Seconds ?? 0) >= P95_CHECK_SECONDS);
  return line("traffic", "Traffic", bad ? "check" : "ok", text);
}

function diskLine(data) {
  const claim = data.storage?.claim;
  if (!claim) return notAvailable("disk", "Database disk", data.errors?.claim);
  const used = data.storage.diskUsedPercent;
  const measured = used !== null && used !== undefined;
  const usedText = measured ? `${Math.round(used)}% used` : "used space not measured";
  const bad = claim.phase !== "Bound" || (measured && used > DISK_CHECK_PERCENT);
  return line(
    "disk",
    "Database disk",
    bad ? "check" : "ok",
    `claim ${claim.name} ${claim.phase}, ${claim.capacity ?? "size unknown"}, ${usedText}`,
  );
}

/** The four lines at the top of the page. */
export function healthLines(data) {
  return [containersLine(data), replicasLine(data), trafficLine(data), diskLine(data)];
}
