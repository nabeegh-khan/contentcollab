// Tests for loadtest-lib.mjs: failure reasons per request and the node-memory guard for the load test (#69).
import { test } from "node:test";
import assert from "node:assert/strict";
import { failureReason, summarizeFailures, parseTopNodes, overMemory } from "./loadtest-lib.mjs";

test("a 5xx response is failed with its status; anything below 500 is not a failure", () => {
  assert.equal(failureReason({ status: 503 }), "http 503");
  assert.equal(failureReason({ status: 500 }), "http 500");
  assert.equal(failureReason({ status: 200 }), null);
  assert.equal(failureReason({ status: 404 }), null);
});

test("an AbortSignal.timeout abort is a timeout", () => {
  const e = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(failureReason(null, e), "timeout");
});

test("a fetch network error is named by its cause code", () => {
  const e = new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  assert.equal(failureReason(null, e), "ECONNRESET");
});

// Shapes seen from Node 24 fetch on 6 Nov 2026: localhost gives an AggregateError that carries the code;
// a blocked port ("bad port") gives a cause with a message and no code
test("a refused connection to localhost (AggregateError cause) is named by its code", () => {
  const cause = Object.assign(new AggregateError([new Error("connect ECONNREFUSED ::1:59999")]), { code: "ECONNREFUSED" });
  assert.equal(failureReason(null, new TypeError("fetch failed", { cause })), "ECONNREFUSED");
});

test("a cause without a code is named by its message", () => {
  assert.equal(failureReason(null, new TypeError("fetch failed", { cause: new Error("bad port") })), "bad port");
});

test("an error without a code falls back to its name", () => {
  assert.equal(failureReason(null, new TypeError("fetch failed")), "TypeError");
});

test("failures are summarized by reason, most frequent first", () => {
  assert.equal(summarizeFailures({ timeout: 3, "http 503": 5, ECONNRESET: 1 }), "http 503:5 timeout:3 ECONNRESET:1");
  assert.equal(summarizeFailures({}), "");
});

// `kubectl top nodes --no-headers` on DOKS, 6 Nov 2026
const top = `default-3es04n   368m   19%   1304Mi   89%
default-3es0h9   420m   22%   1138Mi   77%
`;

test("node memory percentages are read from kubectl top nodes", () => {
  assert.deepEqual(parseTopNodes(top), [
    { node: "default-3es04n", memoryPct: 89 },
    { node: "default-3es0h9", memoryPct: 77 },
  ]);
  assert.deepEqual(parseTopNodes(""), []);
});

test("the guard names the first node above the limit, or null", () => {
  const nodes = parseTopNodes(top);
  assert.equal(overMemory(nodes, 95), null);
  assert.deepEqual(overMemory(nodes, 85), { node: "default-3es04n", memoryPct: 89 });
});
