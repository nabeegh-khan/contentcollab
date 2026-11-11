// Tests for error-rate.mjs: the 5xx share per route, read from the API's JSON request log (#55, ARCHITECTURE D18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate, parseRequestLines } from "./error-rate.mjs";

const SCRIPT = fileURLToPath(new URL("./error-rate.mjs", import.meta.url));

// A request line as the API writes it (api/src/middleware/logger.ts)
function line(route, status, extra = {}) {
  return JSON.stringify({
    timestamp: "2026-11-11T16:35:40.137Z",
    level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    msg: "request",
    http: { request_id: "r-1", method: "GET", route, status_code: status },
    duration_ms: 1.5,
    ...extra,
  });
}

const lines = (...parts) => parts.join("\n") + "\n";
const repeat = (n, text) => Array.from({ length: n }, () => text);

test("reads request lines, with or without the kubectl --prefix", () => {
  const text = lines(
    line("/documents/:documentId", 200),
    `[pod/api-7d9f/api] ${line("/documents/:documentId", 500)}`,
    "api listening on 3000",
    "",
    "not json at all {",
  );
  assert.deepEqual(parseRequestLines(text), [
    { route: "/documents/:documentId", status: 200 },
    { route: "/documents/:documentId", status: 500 },
  ]);
});

test("ignores lines that are not finished requests", () => {
  const failed = JSON.stringify({ msg: "request failed", http: { route: "/x", method: "GET" } });
  const aborted = JSON.stringify({ msg: "request aborted", http: { route: "/x", method: "GET" } });
  const redis = JSON.stringify({ msg: "redis: connected", component: "redis" });
  assert.deepEqual(parseRequestLines(lines(failed, aborted, redis)), []);
});

test("counts 5xx per route and alerts above the threshold", () => {
  const entries = parseRequestLines(
    lines(...repeat(95, line("/a", 200)), ...repeat(5, line("/a", 503)), ...repeat(40, line("/b", 200))),
  );
  const rows = evaluate(entries, { threshold: 0.02, minRequests: 10 });
  assert.deepEqual(
    rows.map((r) => [r.route, r.total, r.errors, r.share, r.state]),
    [
      ["/a", 100, 5, 0.05, "ALERT"],
      ["/b", 40, 0, 0, "ok"],
    ],
  );
});

test("a share equal to the threshold is not an alert", () => {
  const entries = parseRequestLines(lines(...repeat(98, line("/a", 200)), ...repeat(2, line("/a", 500))));
  const [row] = evaluate(entries, { threshold: 0.02, minRequests: 10 });
  assert.equal(row.share, 0.02);
  assert.equal(row.state, "ok");
});

test("a route with fewer requests than the minimum is reported as few, not as an alert", () => {
  const entries = parseRequestLines(lines(line("/rare", 500), line("/rare", 200)));
  const [row] = evaluate(entries, { threshold: 0.02, minRequests: 10 });
  assert.equal(row.state, "few");
});

test("a 4xx is not an error", () => {
  const entries = parseRequestLines(lines(...repeat(20, line("/a", 404))));
  const [row] = evaluate(entries, { threshold: 0.02, minRequests: 10 });
  assert.equal(row.errors, 0);
  assert.equal(row.state, "ok");
});

test("sorts the worst share first, then by route", () => {
  const entries = parseRequestLines(
    lines(
      ...repeat(10, line("/b", 200)),
      ...repeat(10, line("/a", 200)),
      ...repeat(9, line("/c", 200)),
      line("/c", 500),
    ),
  );
  assert.deepEqual(
    evaluate(entries, { threshold: 0.5, minRequests: 1 }).map((r) => r.route),
    ["/c", "/a", "/b"],
  );
});

function run(input, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8", env: { ...process.env, ...env } });
}

test("exits 1 and names the route when a route is above the threshold", () => {
  const r = run(lines(...repeat(20, line("/health", 503))));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\/health/);
  assert.match(r.stdout, /ALERT/);
});

test("exits 0 when every route is under the threshold", () => {
  const r = run(lines(...repeat(50, line("/a", 200))));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ok/);
});

test("exits 2 when the input has no request lines, instead of reporting all clear", () => {
  const r = run("api listening on 3000\n");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no request lines/i);
});

test("exits 2 on a threshold that is not a share between 0 and 1", () => {
  assert.equal(run(lines(line("/a", 200)), { THRESHOLD: "2%" }).status, 2);
  assert.equal(run(lines(line("/a", 200)), { THRESHOLD: "5" }).status, 2);
  assert.equal(run(lines(line("/a", 200)), { MIN_REQUESTS: "-1" }).status, 2);
});

test("THRESHOLD and MIN_REQUESTS come from the environment", () => {
  const input = lines(...repeat(18, line("/a", 200)), ...repeat(2, line("/a", 500)));
  assert.equal(run(input, { THRESHOLD: "0.05" }).status, 0);
  assert.equal(run(input, { THRESHOLD: "0.05", MIN_REQUESTS: "30" }).status, 0);
  assert.equal(run(input, { THRESHOLD: "0.02", MIN_REQUESTS: "30" }).status, 0);
  assert.equal(run(input, { THRESHOLD: "0.02", MIN_REQUESTS: "10" }).status, 1);
});
