#!/usr/bin/env node
// The 5xx share per route over a window, read from the API's JSON request log (#55, ARCHITECTURE D18).
// This is the error-rate check of the demo: no agent in the cluster, only the log.
//
//   kubectl -n contentcollab logs -l app=api --since=5m --tail=-1 --prefix | node scripts/error-rate.mjs
//   THRESHOLD=0.05 MIN_REQUESTS=20 node scripts/error-rate.mjs < saved.log
//
// --tail=-1 matters: with a selector (-l) kubectl logs returns only the last 10 lines of each pod unless told otherwise,
// and the share would be computed from that sample, not from the window. Two more limits of the pipe: its exit
// status is this script's, so a kubectl error after some output is not seen (in bash, `set -o pipefail` shows it);
// and a container that restarted keeps its earlier lines only in `kubectl logs --previous`.
//
// THRESHOLD is a share between 0 and 1 (default 0.02, the alert level in the failure table of ARCHITECTURE);
// MIN_REQUESTS is the fewest requests a route needs before its share can raise an alert (default 10), so one
// failure on a quiet route does not. Exit 0: no route above the threshold; 1: at least one is; 2: no request
// lines in the input (wrong command, or no traffic), a request line that could not be read (the verdict would
// cover less than the window), a bad setting, or a crash. An all-clear is never reported for such an input.
//
// Reads the "request" lines, and counts "request aborted" lines (the client went away before the answer) in a
// separate column: they are not 5xx and do not change the share. A successful /health or /metrics is logged at
// debug (D16), so at the default LOG_LEVEL=info the log holds their failures only: MIN_REQUESTS does not apply to
// them, and any failing probe is an alert.
//
// Two cases read as failures that may not be: at LOG_LEVEL=warn or error no successful request is logged, so every
// route's share comes from its errors alone (run the API at info or debug for this check); and a readiness probe
// that reaches a new pod before it has connected to Redis answers 503, so a scale-up or a rollout inside the window
// can show a /health failure or two. Read the count, and the pods' ages, before acting on a probe alert.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SERVER_ERROR_MIN = 500;
const DEFAULT_THRESHOLD = 0.02;
const DEFAULT_MIN_REQUESTS = 10;
const PERCENT = 100;
const SHARE_DECIMALS = 2;
const PROBE_ROUTES = new Set(["/health", "/metrics"]);
const UNMATCHED = "unmatched";

// A line meant to be a request line, even when it is cut short or is not valid JSON.
// Matches '{"msg":"request","http"' and '..."msg":"request"}'; rejects '"msg":"request aborted"'.
// Try it: https://regex101.com/?regex=%22msg%22%3A%22request%22%5B%2C%7D%5D
const LOOKS_LIKE_REQUEST = /"msg":"request"[,}]/;

/**
 * @param {string} text log lines, as the API writes them or with the prefix `kubectl logs --prefix` adds
 * @returns {{requests: {route: string, status: number}[], aborted: {route: string}[], unreadable: number}}
 *   finished requests, aborted requests, and request lines that could not be read
 */
export function readLog(text) {
  const result = { requests: [], aborted: [], unreadable: 0 };
  for (const raw of text.split("\n")) {
    const start = raw.indexOf("{");
    if (start < 0) continue;
    let entry;
    try {
      entry = JSON.parse(raw.slice(start));
    } catch {
      if (LOOKS_LIKE_REQUEST.test(raw)) result.unreadable += 1;
      continue;
    }
    const route = String(entry?.http?.route ?? UNMATCHED);
    if (entry?.msg === "request aborted") {
      result.aborted.push({ route });
    } else if (entry?.msg === "request") {
      const status = entry.http?.status_code;
      if (Number.isInteger(status)) result.requests.push({ route, status });
      else result.unreadable += 1;
    }
  }
  return result;
}

/**
 * @param {string} text
 * @returns {{route: string, status: number}[]} one entry per finished request
 */
export function parseRequestLines(text) {
  return readLog(text).requests;
}

/**
 * @param {{route: string, status: number}[]} entries
 * @param {{threshold: number, minRequests: number, aborted?: {route: string}[]}} options
 * @returns {{route: string, total: number, errors: number, aborted: number, share: number, state: "ALERT"|"few"|"ok"}[]}
 *   worst share first, then by route. "few": errors seen but fewer requests than minRequests to judge by.
 */
export function evaluate(entries, { threshold, minRequests, aborted = [] }) {
  const byRoute = new Map();
  const rowFor = (route) => byRoute.get(route) ?? { route, total: 0, errors: 0, aborted: 0 };
  for (const { route, status } of entries) {
    const row = rowFor(route);
    row.total += 1;
    if (status >= SERVER_ERROR_MIN) row.errors += 1;
    byRoute.set(route, row);
  }
  for (const { route } of aborted) {
    const row = rowFor(route);
    row.aborted += 1;
    byRoute.set(route, row);
  }
  return [...byRoute.values()]
    .map((row) => {
      const share = row.total === 0 ? 0 : row.errors / row.total;
      const enough = PROBE_ROUTES.has(row.route) || row.total >= minRequests;
      const state = enough && share > threshold ? "ALERT" : !enough && row.errors > 0 ? "few" : "ok";
      return { ...row, share, state };
    })
    .sort((a, b) => b.share - a.share || a.route.localeCompare(b.route));
}

// A plain decimal: "0.05", "10". Number() alone would also take " " (as 0), "0x0" and "1e1".
// Matches "0.05" and "10"; rejects " ", "0x0", "1e1", "-1" and ".5".
// Try it: https://regex101.com/?regex=%5E%5Cd%2B(%5C.%5Cd%2B)%3F%24
const DECIMAL = /^\d+(\.\d+)?$/;

function readSetting(name, fallback, valid) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = DECIMAL.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || !valid(value)) {
    console.error(`${name}=${JSON.stringify(raw)} is not valid`);
    process.exit(2);
  }
  return value;
}

function main() {
  const threshold = readSetting("THRESHOLD", DEFAULT_THRESHOLD, (v) => v >= 0 && v <= 1);
  const minRequests = readSetting("MIN_REQUESTS", DEFAULT_MIN_REQUESTS, (v) => Number.isInteger(v) && v >= 0);
  const { requests, aborted, unreadable } = readLog(readFileSync(0, "utf8"));
  if (requests.length === 0 && unreadable === 0) {
    console.error("no request lines in the input: check the command, or send some traffic first");
    process.exit(2);
  }
  const rows = evaluate(requests, { threshold, minRequests, aborted });
  const width = Math.max(5, ...rows.map((r) => r.route.length));
  console.log(`${"route".padEnd(width)}  requests  5xx  share    state  aborted`);
  for (const r of rows) {
    const share = `${(r.share * PERCENT).toFixed(SHARE_DECIMALS)}%`;
    console.log(
      `${r.route.padEnd(width)}  ${String(r.total).padStart(8)}  ${String(r.errors).padStart(3)}  ${share.padStart(7)}  ${r.state.padEnd(5)}  ${String(r.aborted).padStart(7)}`,
    );
  }
  console.log(
    `threshold ${Number((threshold * PERCENT).toFixed(SHARE_DECIMALS))}% with at least ${minRequests} requests; ` +
      `${requests.length} requests read, ${aborted.length} aborted; a failing probe (/health, /metrics) alerts at any count`,
  );
  if (unreadable > 0) {
    console.error(`${unreadable} request lines could not be read: the result covers only part of the window`);
    process.exit(2);
  }
  process.exit(rows.some((r) => r.state === "ALERT") ? 1 : 0);
}

// A crash must not look like an alert: node exits 1 on an uncaught error, which is this script's ALERT code
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`error-rate failed: ${err?.message ?? String(err)}`);
    process.exit(2);
  }
}
