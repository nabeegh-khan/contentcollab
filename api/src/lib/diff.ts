// The line diff of two texts (#23, ARCHITECTURE D33). A copy of lineDiff from worker/src/lib/diff.ts (D21): the two
// services are built from their own folders and share no code, so keep the copies in step. Pure: no storage, no database.
// lineDiff: longest common subsequence over lines.

/**
 * Above this many cells of the LCS table, (before lines + 1) x (after lines + 1), the diff is refused,
 * not computed: the table and the result both grow with it. The +1 makes one empty side still count.
 */
export const MAX_TABLE_CELLS = 4_000_000;

/**
 * Above this many characters, before and after together, the diff is refused: the input and
 * the result grow with it, whatever the line count.
 */
export const MAX_INPUT_CHARS = 2_000_000;

export class DiffTooLargeError extends Error {
  constructor(what: "cells" | "chars", size: number) {
    const limit = what === "cells" ? MAX_TABLE_CELLS : MAX_INPUT_CHARS;
    const unit = what === "cells" ? "table cells" : "characters";
    super(`diff too large: ${size} ${unit}, limit ${limit}`);
    this.name = "DiffTooLargeError";
  }
}

const totalChars = (texts: string[]) => texts.reduce((sum, t) => sum + t.length, 0);

function checkChars(texts: string[]): void {
  const chars = totalChars(texts);
  if (chars > MAX_INPUT_CHARS) throw new DiffTooLargeError("chars", chars);
}

const tableCells = (a: string[], b: string[]) => (a.length + 1) * (b.length + 1);

/**
 * Each distinct line as a small integer, shared by both sides, so the LCS compares numbers: a long
 * line costs its length once here, not once per table cell.
 */
function internLines(a: string[], b: string[]): { a: Uint32Array; b: Uint32Array } {
  const ids = new Map<string, number>();
  const idOf = (line: string) => {
    const known = ids.get(line);
    if (known !== undefined) return known;
    ids.set(line, ids.size);
    return ids.size - 1;
  };
  return { a: Uint32Array.from(a, idOf), b: Uint32Array.from(b, idOf) };
}

export type DiffLine =
  | { op: "keep"; text: string; before: number; after: number }
  | { op: "remove"; text: string; before: number }
  | { op: "add"; text: string; after: number };

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Lines of a text: CRLF and LF alike, a final newline does not make an empty last line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

/**
 * table[i][j]: length of the longest common subsequence of a[i..] and b[j..]. Rows are filled from
 * the last line of `a` up, each row from its last column left, since a cell reads the row below it
 * and the cell to its right.
 */
function lcsTable(a: Uint32Array, b: Uint32Array): Uint32Array[] {
  const width = b.length + 1;
  const bottomUp = a.reduceRight<Uint32Array[]>(
    (rows, line) => {
      const below = rows[rows.length - 1]!;
      const row = new Uint32Array(width);
      b.reduceRight((_, other, j) => {
        row[j] = line === other ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
        return 0;
      }, 0);
      rows.push(row);
      return rows;
    },
    [new Uint32Array(width)],
  );
  return bottomUp.reverse();
}

interface Walk {
  i: number;
  j: number;
  lines: DiffLine[];
}

interface Sides {
  a: string[];
  b: string[];
  ids: { a: Uint32Array; b: Uint32Array };
  table: Uint32Array[];
}

/** One step of the walk through the table; on a tie the removal goes first, so a changed line reads
 * as the old line removed, then the new one added. */
function step({ a, b, ids, table }: Sides, w: Walk): Walk {
  const { i, j, lines } = w;
  if (i < a.length && j < b.length && ids.a[i] === ids.b[j]) {
    lines.push({ op: "keep", text: a[i]!, before: i + 1, after: j + 1 });
    return { i: i + 1, j: j + 1, lines };
  }
  const removeFirst = j >= b.length || (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!);
  if (i < a.length && removeFirst) {
    lines.push({ op: "remove", text: a[i]!, before: i + 1 });
    return { i: i + 1, j, lines };
  }
  if (j < b.length) lines.push({ op: "add", text: b[j]!, after: j + 1 });
  return { i, j: j + 1, lines };
}

/** The diff of two texts already split and checked against the limits. */
function diffSplit(a: string[], b: string[]): LineDiff {
  const ids = internLines(a, b);
  const sides: Sides = { a, b, ids, table: lcsTable(ids.a, ids.b) };
  // Every step consumes at least one line of a or b, so a.length + b.length steps finish the walk
  const { lines } = Array.from({ length: a.length + b.length }).reduce<Walk>(
    (w) => (w.i >= a.length && w.j >= b.length ? w : step(sides, w)),
    { i: 0, j: 0, lines: [] },
  );
  return {
    lines,
    added: lines.filter((l) => l.op === "add").length,
    removed: lines.filter((l) => l.op === "remove").length,
  };
}

export function lineDiff(beforeText: string, afterText: string): LineDiff {
  checkChars([beforeText, afterText]);
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  const cells = tableCells(a, b);
  if (cells > MAX_TABLE_CELLS) throw new DiffTooLargeError("cells", cells);
  return diffSplit(a, b);
}
