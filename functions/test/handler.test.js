// Tests for the compare/diff function (#180, ARCHITECTURE D39). Written before the code.
const test = require("node:test");
const assert = require("node:assert/strict");
const { main, MAX_RESPONSE_BYTES } = require("../packages/compare/diff/index.js");

test("a changed line reads as the old line removed, then the new one added", async () => {
  const res = await main({ before: "a\nb\nc\n", after: "a\nB\nc\n" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.lines, [
    { op: "keep", text: "a", before: 1, after: 1 },
    { op: "remove", text: "b", before: 2 },
    { op: "add", text: "B", after: 2 },
    { op: "keep", text: "c", before: 3, after: 3 },
  ]);
  assert.equal(res.body.added, 1);
  assert.equal(res.body.removed, 1);
});

test("CRLF and LF compare alike, and a final newline adds no line", async () => {
  const res = await main({ before: "a\r\nb\r\n", after: "a\nb" });
  assert.equal(res.body.added, 0);
  assert.equal(res.body.removed, 0);
});

test("the reply says how long the diff took, in milliseconds", async () => {
  const res = await main({ before: "x", after: "y" });
  assert.equal(typeof res.body.computeMs, "number");
  assert.ok(res.body.computeMs >= 0);
});

test("a missing or non-string side is 400 and names the fields", async () => {
  const bad = [{}, { before: "a" }, { before: 1, after: "a" }, { before: "a", after: null }];
  for (const args of bad) {
    const res = await main(args);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /before and after/);
  }
});

test("inputs above the diff's own limits are 413, not a crash", async () => {
  const many = "x\n".repeat(2500);
  const res = await main({ before: many, after: many + "y\n".repeat(2500) });
  assert.equal(res.statusCode, 413);
  assert.match(res.body.error, /too large/);
});

test("a result whose JSON would pass the response limit is 413", async () => {
  // 400 long distinct lines a side: the input is under 1 MB, the diff repeats every line's text
  const line = (n) => `${n}-`.padEnd(1100, "z");
  const before = Array.from({ length: 400 }, (_, i) => line(i)).join("\n");
  const after = Array.from({ length: 400 }, (_, i) => line(i + 1000)).join("\n");
  assert.ok(Buffer.byteLength(before) + Buffer.byteLength(after) < 1_000_000);
  const res = await main({ before, after });
  assert.equal(res.statusCode, 413);
  assert.match(res.body.error, /response/);
  assert.equal(MAX_RESPONSE_BYTES, 900_000);
});

test("an error never echoes the texts", async () => {
  const res = await main({ before: "private-words", after: 5 });
  assert.ok(!JSON.stringify(res).includes("private-words"));
});
