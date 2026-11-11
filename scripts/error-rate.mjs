#!/usr/bin/env node
// The 5xx share per route over a window, read from the API's JSON request log (#55, ARCHITECTURE D18).
// This is the error-rate check of the demo: no agent in the cluster, only the log.
//
//   kubectl -n contentcollab logs -l app=api --since=5m --prefix | node scripts/error-rate.mjs
//   THRESHOLD=0.05 MIN_REQUESTS=20 node scripts/error-rate.mjs < saved.log
//
// THRESHOLD is a share between 0 and 1 (default 0.02, the alert level in the failure table of ARCHITECTURE);
// MIN_REQUESTS is the fewest requests a route needs before its share can raise an alert (default 10), so one
// failure on a quiet route does not. Exit 0: no route above the threshold; 1: at least one is; 2: no request
// lines in the input (wrong command, or no traffic) or a bad setting. An all-clear is never reported for
// an input with no requests.
//
// Reads only the "request" lines. A successful /health or /metrics is logged at debug (D16), so for those routes
// the log holds failures only and their share is 100% whenever any appear: any failing probe is an alert.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SERVER_ERROR_MIN = 500;
const DEFAULT_THRESHOLD = 0.02;
const DEFAULT_MIN_REQUESTS = 10;
const PERCENT = 100;
const SHARE_DECIMALS = 2;

/**
 * @param {string} text log lines, as the API writes them or with the prefix `kubectl logs --prefix` adds
 * @returns {{route: string, status: number}[]} one entry per finished request
 */
export function parseRequestLines(text) {
  return text
    .split("\n")
    .map((raw) => {
      const start = raw.indexOf("{");
      if (start < 0) return undefined;
      try {
        return JSON.parse(raw.slice(start));
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry?.msg === "request" && typeof entry.http?.status_code === "number")
    .map((entry) => ({ route: String(entry.http.route ?? "unmatched"), status: entry.http.status_code }));
}

/**
 * @param {{route: string, status: number}[]} entries
 * @param {{threshold: number, minRequests: number}} options
 * @returns {{route: string, total: number, errors: number, share: number, state: "ALERT"|"few"|"ok"}[]}
 *   worst share first, then by route. "few": errors seen but fewer requests than minRequests to judge by.
 */
export function evaluate(entries, { threshold, minRequests }) {
  const byRoute = new Map();
  for (const { route, status } of entries) {
    const row = byRoute.get(route) ?? { route, total: 0, errors: 0 };
    row.total += 1;
    if (status >= SERVER_ERROR_MIN) row.errors += 1;
    byRoute.set(route, row);
  }
  return [...byRoute.values()]
    .map((row) => {
      const share = row.errors / row.total;
      const enough = row.total >= minRequests;
      const state = enough && share > threshold ? "ALERT" : !enough && row.errors > 0 ? "few" : "ok";
      return { ...row, share, state };
    })
    .sort((a, b) => b.share - a.share || a.route.localeCompare(b.route));
}

function readSetting(name, fallback, valid) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !valid(value)) {
    console.error(`${name}=${raw} is not valid`);
    process.exit(2);
  }
  return value;
}

function main() {
  const threshold = readSetting("THRESHOLD", DEFAULT_THRESHOLD, (v) => v >= 0 && v <= 1);
  const minRequests = readSetting("MIN_REQUESTS", DEFAULT_MIN_REQUESTS, (v) => Number.isInteger(v) && v >= 0);
  const entries = parseRequestLines(readFileSync(0, "utf8"));
  if (entries.length === 0) {
    console.error("no request lines in the input: check the command, or send some traffic first");
    process.exit(2);
  }
  const rows = evaluate(entries, { threshold, minRequests });
  const width = Math.max(5, ...rows.map((r) => r.route.length));
  console.log(`${"route".padEnd(width)}  requests  5xx  share    state`);
  for (const r of rows) {
    const share = `${(r.share * PERCENT).toFixed(SHARE_DECIMALS)}%`;
    console.log(
      `${r.route.padEnd(width)}  ${String(r.total).padStart(8)}  ${String(r.errors).padStart(3)}  ${share.padStart(7)}  ${r.state}`,
    );
  }
  console.log(`threshold ${threshold * PERCENT}% with at least ${minRequests} requests; ${entries.length} requests read`);
  process.exit(rows.some((r) => r.state === "ALERT") ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
