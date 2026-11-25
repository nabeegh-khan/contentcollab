// The line diff of two texts (#180, ARCHITECTURE D39). A copy of lineDiff from api/src/lib/diff.ts (D33): the
// function is deployed from its own folder and shares no code with the services, so keep the copies in step.
// Pure: no storage, no network. Longest common subsequence over lines.

// Above this many cells of the table, (before lines + 1) x (after lines + 1), the diff is refused.
const MAX_TABLE_CELLS = 4_000_000;
// Above this many characters, before and after together, the diff is refused.
const MAX_INPUT_CHARS = 2_000_000;

class DiffTooLargeError extends Error {
  constructor(what, size) {
    const limit = what === "cells" ? MAX_TABLE_CELLS : MAX_INPUT_CHARS;
    const unit = what === "cells" ? "table cells" : "characters";
    super(`diff too large: ${size} ${unit}, limit ${limit}`);
    this.name = "DiffTooLargeError";
  }
}

// Each distinct line as a small integer shared by both sides, so the table compares numbers
function internLines(a, b) {
  const ids = new Map();
  const idOf = (line) => {
    if (!ids.has(line)) ids.set(line, ids.size);
    return ids.get(line);
  };
  return { a: Uint32Array.from(a, idOf), b: Uint32Array.from(b, idOf) };
}

// CRLF and LF alike; a final newline does not make an empty last line
function splitLines(text) {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

// table[i][j]: length of the longest common subsequence of a[i..] and b[j..]
function lcsTable(a, b) {
  const width = b.length + 1;
  const table = [new Uint32Array(width)];
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const below = table[0];
    const row = new Uint32Array(width);
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? below[j + 1] + 1 : Math.max(below[j], row[j + 1]);
    }
    table.unshift(row);
  }
  return table;
}

// The walk through the table; on a tie the removal goes first, so a changed line reads as the old
// line removed, then the new one added
function walk(a, b, ids, table) {
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && ids.a[i] === ids.b[j]) {
      lines.push({ op: "keep", text: a[i], before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && table[i + 1][j] >= table[i][j + 1])) {
      lines.push({ op: "remove", text: a[i], before: i + 1 });
      i += 1;
    } else {
      lines.push({ op: "add", text: b[j], after: j + 1 });
      j += 1;
    }
  }
  return lines;
}

function lineDiff(beforeText, afterText) {
  const chars = beforeText.length + afterText.length;
  if (chars > MAX_INPUT_CHARS) throw new DiffTooLargeError("chars", chars);
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  const cells = (a.length + 1) * (b.length + 1);
  if (cells > MAX_TABLE_CELLS) throw new DiffTooLargeError("cells", cells);
  const ids = internLines(a, b);
  const lines = walk(a, b, ids, lcsTable(ids.a, ids.b));
  return {
    lines,
    added: lines.filter((l) => l.op === "add").length,
    removed: lines.filter((l) => l.op === "remove").length,
  };
}

module.exports = { lineDiff, DiffTooLargeError, MAX_TABLE_CELLS, MAX_INPUT_CHARS };
