// The version diff (#23, ARCHITECTURE D21): line diff for text, page-by-page for PDFs (page text).
// Fixture files stand in for two versions; nothing here reads storage or the database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lineDiff, pageDiff, MAX_TABLE_CELLS, MAX_INPUT_CHARS, DiffTooLargeError } from "./diff.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/diff/${name}`, import.meta.url), "utf8");

// Line numbers in notes-v1.md and notes-v2.md (1-based)
const SHARES_LINE = 4;
const REVERT_LINE_V2 = 6;
// Expected counts for the notes fixtures: one line reworded, one appended
const NOTES_ADDED = 2;
const NOTES_REMOVED = 1;

test("identical texts: every line kept, nothing added or removed", () => {
  const text = fixture("notes-v1.md");
  const d = lineDiff(text, text);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.ok(d.lines.every((l) => l.op === "keep"));
});

test("a changed line is a removal and an addition; an appended line is an addition", () => {
  const d = lineDiff(fixture("notes-v1.md"), fixture("notes-v2.md"));
  assert.equal(d.removed, NOTES_REMOVED);
  assert.equal(d.added, NOTES_ADDED);
  assert.deepEqual(
    d.lines.filter((l) => l.op !== "keep"),
    [
      { op: "remove", text: "- Shares expire after seven days.", before: SHARES_LINE },
      { op: "add", text: "- Shares expire after the date the owner sets.", after: SHARES_LINE },
      { op: "add", text: "- Revert makes a new version.", after: REVERT_LINE_V2 },
    ],
  );
});

test("line numbers of kept lines refer to both versions", () => {
  // One line inserted at the top shifts every kept line by one in the new version
  const before = ["a", "b", "c"];
  const d = lineDiff(before.join("\n"), ["x", ...before].join("\n"));
  assert.deepEqual(
    d.lines.filter((l) => l.op === "keep"),
    before.map((text, i) => ({ op: "keep", text, before: i + 1, after: i + 1 + 1 })),
  );
});

test("Windows line endings and a final newline do not count as changes", () => {
  const d = lineDiff("one\r\ntwo\r\n", "one\ntwo");
  assert.equal(d.added + d.removed, 0);
});

test("empty versions", () => {
  assert.deepEqual(lineDiff("", "").lines, []);
  const d = lineDiff("", "only line");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
});

test("inputs above the table-size limit are refused, not computed", () => {
  const n = Math.floor(Math.sqrt(MAX_TABLE_CELLS)) + 1;
  const big = Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
  assert.throws(() => lineDiff(big, big + "\nmore"), DiffTooLargeError);
});

test("a huge version against an empty one is refused too (its lines are the cost)", () => {
  const lines = Math.floor(Math.sqrt(MAX_TABLE_CELLS)) * Math.floor(Math.sqrt(MAX_TABLE_CELLS)) + 1;
  const huge = "x\n".repeat(lines);
  assert.throws(() => lineDiff("", huge), DiffTooLargeError);
  assert.throws(() => lineDiff(huge, "one line"), DiffTooLargeError);
});

test("one very long line on each side is refused by size, though its table is tiny", () => {
  // Two lines make a 2 x 2 table; the cap on characters is what keeps them out of memory
  const long = "a".repeat(MAX_INPUT_CHARS);
  assert.throws(() => lineDiff(long, "b"), DiffTooLargeError);
});

test("pages are refused when their characters add up past the limit, each pair under it", () => {
  const PAGE_SHARE = 0.4;
  const page = (ch: string) => ch.repeat(Math.floor(MAX_INPUT_CHARS * PAGE_SHARE));
  // Each page pair is 0.8 of the limit; the job as a whole is 1.6
  assert.throws(() => pageDiff([page("a"), page("b")], [page("c"), page("d")]), DiffTooLargeError);
});

test("pages are refused when their tables add up past the limit, each one under it", () => {
  // Each changed page alone is under MAX_TABLE_CELLS; together they are over it
  const PAGES = 2;
  const perPage = Math.floor(Math.sqrt(MAX_TABLE_CELLS / PAGES)) + 1;
  const text = (tag: string) => Array.from({ length: perPage }, (_, i) => `${tag} ${i}`).join("\n");
  const before = Array.from({ length: PAGES }, (_, p) => text(`b${p}`));
  const after = Array.from({ length: PAGES }, (_, p) => text(`a${p}`));
  assert.ok((perPage + 1) ** 2 < MAX_TABLE_CELLS);
  assert.throws(() => pageDiff(before, after), DiffTooLargeError);
});

test("long lines that differ only at the end still diff correctly (lines compared by identity)", () => {
  const LONG = 10_000;
  const stem = "x".repeat(LONG);
  const d = lineDiff(`${stem}1\n${stem}2`, `${stem}1\n${stem}3`);
  assert.deepEqual(
    d.lines.map((l) => l.op),
    ["keep", "remove", "add"],
  );
});

test("pages are compared by position: unchanged, changed with its line diff, added", () => {
  const { before, after } = JSON.parse(fixture("report-pages.json")) as {
    before: string[];
    after: string[];
  };
  const d = pageDiff(before, after);
  // The fixture: page 2 reworded, page 4 new
  assert.deepEqual(
    d.pages.map((p) => p.status),
    ["unchanged", "changed", "unchanged", "added"],
  );
  assert.deepEqual(
    d.pages.map((p) => p.page),
    after.map((_, i) => i + 1),
  );
  const changed = d.pages.find((p) => p.status === "changed");
  assert.ok(changed && changed.status === "changed");
  assert.equal(changed.diff.removed, 1);
  assert.equal(changed.diff.added, 1);
  const count = (status: string) => d.pages.filter((p) => p.status === status).length;
  assert.deepEqual(d.summary, { unchanged: count("unchanged"), changed: 1, added: 1, removed: 0 });
  assert.equal(d.summary.unchanged, before.length - 1);
});

test("a page dropped from the end is removed", () => {
  const d = pageDiff(["a", "b"], ["a"]);
  assert.deepEqual(
    d.pages.map((p) => p.status),
    ["unchanged", "removed"],
  );
});
