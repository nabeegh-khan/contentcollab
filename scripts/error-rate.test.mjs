// Tests for error-rate.mjs: the 5xx share per route, read from the API's JSON request log (#55, ARCHITECTURE D18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

// THRESHOLD and MIN_REQUESTS are cleared first, so a value exported in the shell cannot change a test
function run(input, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    input,
    encoding: "utf8",
    env: { ...process.env, THRESHOLD: "", MIN_REQUESTS: "", ...env },
  });
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
  // 2 of 20 is a 10% share
  assert.equal(run(input, { THRESHOLD: "0.5" }).status, 0);
  assert.equal(run(input, { THRESHOLD: "0.05" }).status, 1);
  assert.equal(run(input, { THRESHOLD: "0.05", MIN_REQUESTS: "30" }).status, 0);
  assert.equal(run(input, { THRESHOLD: "0.05", MIN_REQUESTS: "10" }).status, 1);
});

test("a route with exactly the minimum number of requests is judged", () => {
  const entries = parseRequestLines(lines(...repeat(9, line("/a", 200)), line("/a", 500)));
  const [row] = evaluate(entries, { threshold: 0.02, minRequests: 10 });
  assert.equal(row.total, 10);
  assert.equal(row.state, "ALERT");
});

test("the defaults are 2% and 10 requests", () => {
  assert.equal(run(lines(...repeat(97, line("/a", 200)), ...repeat(3, line("/a", 500)))).status, 1);
  assert.equal(run(lines(...repeat(98, line("/a", 200)), ...repeat(2, line("/a", 500)))).status, 0);
  // 1 failure in 9 requests is below the default minimum of 10: few, not an alert
  assert.equal(run(lines(...repeat(8, line("/a", 200)), line("/a", 500))).status, 0);
});

test("a request line with no route is counted under unmatched", () => {
  const noRoute = JSON.stringify({ msg: "request", http: { method: "GET", status_code: 404 } });
  assert.deepEqual(parseRequestLines(lines(noRoute)), [{ route: "unmatched", status: 404 }]);
});

test("MIN_REQUESTS must be a whole number", () => {
  assert.equal(run(lines(line("/a", 200)), { MIN_REQUESTS: "1.5" }).status, 2);
});

test("the output names each route's requests, 5xx count and share", () => {
  const r = run(lines(...repeat(96, line("/a", 200)), ...repeat(4, line("/a", 500))));
  assert.match(r.stdout, /\/a\s+100\s+4\s+4\.00%\s+ALERT/);
  assert.match(r.stdout, /threshold 2% with at least 10 requests; 100 requests read/);
});

// Review round 2 (pass 1 of the second verification): error paths and the documented command

test("a crash exits 2, not 1, so a bug never looks like an alert", () => {
  // Makes the report printing throw inside main()
  const boom = "data:text/javascript,String.prototype.padEnd=()=>{throw new Error('boom')}";
  const r = spawnSync(process.execPath, ["--import", boom, SCRIPT], {
    input: lines(line("/a", 200)),
    encoding: "utf8",
    env: { ...process.env, THRESHOLD: "", MIN_REQUESTS: "" },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /error-rate failed: boom/);
});

test("a setting of only spaces is refused, not read as 0", () => {
  assert.equal(run(lines(line("/a", 200)), { THRESHOLD: " " }).status, 2);
  assert.equal(run(lines(line("/a", 200)), { MIN_REQUESTS: " " }).status, 2);
});

test("THRESHOLD 0 and 1 and MIN_REQUESTS 0 are accepted at the edges", () => {
  const one = lines(line("/a", 500));
  assert.equal(run(one, { THRESHOLD: "1", MIN_REQUESTS: "0" }).status, 0);
  assert.equal(run(one, { THRESHOLD: "0", MIN_REQUESTS: "0" }).status, 1);
});

test("a failing probe is an alert however few lines it has: probe successes are never logged at info", () => {
  const r = run(lines(...repeat(3, line("/health", 503))));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\/health\s+3\s+3\s+100\.00%\s+ALERT/);
  assert.equal(run(lines(line("/metrics", 500))).status, 1);
  // Other routes keep the minimum
  assert.equal(run(lines(...repeat(3, line("/a", 503)))).status, 0);
});

test("a request line the check cannot read is counted and makes the run exit 2", () => {
  const stringStatus = JSON.stringify({ msg: "request", http: { route: "/a", status_code: "500" } });
  const truncated = '{"timestamp":"x","level":"error","msg":"request","http":{"route":"/a","status_';
  const r = run(lines(...repeat(20, line("/a", 200)), stringStatus, truncated));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /2 request lines could not be read/);
  // The table is still printed for what could be read
  assert.match(r.stdout, /\/a\s+20\s+0/);
});

test("aborted requests are counted per route and reported, not dropped", () => {
  const aborted = JSON.stringify({ msg: "request aborted", http: { request_id: "r", method: "GET", route: "/a" } });
  const r = run(lines(...repeat(10, line("/a", 200)), ...repeat(30, aborted)));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\/a\s+10\s+0\s+0\.00%\s+ok\s+30/);
  assert.match(r.stdout, /10 requests read, 30 aborted/);
});

test("a quiet route with no errors is ok, not few", () => {
  const [row] = evaluate(parseRequestLines(lines(...repeat(3, line("/a", 200)))), {
    threshold: 0.02,
    minRequests: 10,
  });
  assert.equal(row.state, "ok");
});

test("reads CRLF input as well", () => {
  assert.equal(parseRequestLines(`${line("/a", 200)}\r\n${line("/a", 500)}\r\n`).length, 2);
});

test("every documented kubectl logs -l command piped into the check asks for every line (--tail=-1)", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = ["scripts/README.md", "scripts/error-rate.mjs", "docs/DEMO_OBSERVABILITY.md", "docs/PRESENTATION.md"];
  const commands = files.flatMap((f) =>
    readFileSync(`${root}${f}`, "utf8")
      .split("\n")
      .filter((l) => /logs -l/.test(l) && /error-rate\.mjs/.test(l))
      .map((l) => [f, l]),
  );
  assert.ok(commands.length >= 4, `found ${commands.length} documented commands`);
  for (const [f, l] of commands) assert.match(l, /--tail=-1/, `${f}: ${l}`);
});

test("files under scripts/ are stored with LF line endings, so a diff shows only the lines that changed", () => {
  // Reads git's index, not the working tree, so a Windows checkout with CRLF does not matter
  const root = fileURLToPath(new URL("..", import.meta.url));
  const listing = spawnSync("git", ["ls-files", "--eol", "scripts"], { cwd: root, encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  const crlf = listing.stdout
    .split("\n")
    .filter((row) => row.startsWith("i/crlf"))
    .map((row) => row.split("\t")[1]);
  assert.deepEqual(crlf, []);
});

test("only plain decimal settings are read: hex or exponents are refused", () => {
  assert.equal(run(lines(line("/a", 200)), { THRESHOLD: "0x0" }).status, 2);
  assert.equal(run(lines(line("/a", 200)), { MIN_REQUESTS: "1e1" }).status, 2);
  assert.equal(run(lines(line("/a", 200)), { THRESHOLD: "0.05", MIN_REQUESTS: "10" }).status, 0);
});
