const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { lineDiff, DiffTooLargeError, MAX_INPUT_CHARS } = require("../packages/compare/diff/diff.js");

test("empty against empty is an empty diff", () => {
  assert.deepEqual(lineDiff("", ""), { lines: [], added: 0, removed: 0 });
});

test("an empty side makes every line an add or a remove", () => {
  assert.equal(lineDiff("", "a\nb").added, 2);
  assert.equal(lineDiff("a\nb", "").removed, 2);
});

test("more than the character limit is refused", () => {
  assert.throws(() => lineDiff("a".repeat(MAX_INPUT_CHARS), "b"), DiffTooLargeError);
});

test("the worker's fixtures give a diff whose counts match its lines", () => {
  const dir = path.join(__dirname, "../../worker/src/lib/fixtures/diff");
  const v1 = fs.readFileSync(path.join(dir, "notes-v1.md"), "utf8");
  const v2 = fs.readFileSync(path.join(dir, "notes-v2.md"), "utf8");
  const d = lineDiff(v1, v2);
  assert.ok(d.added + d.removed > 0);
  assert.equal(d.lines.filter((l) => l.op === "add").length, d.added);
  assert.equal(d.lines.filter((l) => l.op === "remove").length, d.removed);
});
