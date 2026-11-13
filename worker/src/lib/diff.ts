// What changed between two versions (#23, ARCHITECTURE D21). Pure functions: no storage, no database.
// lineDiff: longest common subsequence over lines. pageDiff: pages compared by position, each changed
// page carrying its own line diff (PDF page text; rendering pages to images is not done here).

/**
 * Above this many cells of the LCS table, (before lines + 1) x (after lines + 1), the diff is refused,
 * not computed: the table and the result both grow with it. The +1 makes one empty side still count.
 */
export const MAX_TABLE_CELLS = 4_000_000;

export class DiffTooLargeError extends Error {
  constructor(cells: number) {
    super(`diff too large: ${cells} table cells, limit ${MAX_TABLE_CELLS}`);
    this.name = "DiffTooLargeError";
  }
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

export type PageResult =
  | { page: number; status: "unchanged" }
  | { page: number; status: "changed"; diff: LineDiff }
  | { page: number; status: "added" }
  | { page: number; status: "removed" };

export interface PageDiff {
  pages: PageResult[];
  summary: { unchanged: number; changed: number; added: number; removed: number };
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
function lcsTable(a: string[], b: string[]): Uint32Array[] {
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

/** One step of the walk through the table; on a tie the removal goes first, so a changed line reads
 * as the old line removed, then the new one added. */
function step(a: string[], b: string[], table: Uint32Array[], w: Walk): Walk {
  const { i, j, lines } = w;
  if (i < a.length && j < b.length && a[i] === b[j]) {
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

export function lineDiff(beforeText: string, afterText: string): LineDiff {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  const cells = (a.length + 1) * (b.length + 1);
  if (cells > MAX_TABLE_CELLS) throw new DiffTooLargeError(cells);

  const table = lcsTable(a, b);
  // Every step consumes at least one line of a or b, so a.length + b.length steps finish the walk
  const { lines } = Array.from({ length: a.length + b.length }).reduce<Walk>(
    (w) => (w.i >= a.length && w.j >= b.length ? w : step(a, b, table, w)),
    { i: 0, j: 0, lines: [] },
  );
  return {
    lines,
    added: lines.filter((l) => l.op === "add").length,
    removed: lines.filter((l) => l.op === "remove").length,
  };
}

function comparePage(
  page: number,
  before: string | undefined,
  after: string | undefined,
): PageResult {
  if (before === undefined) return { page, status: "added" };
  if (after === undefined) return { page, status: "removed" };
  if (before === after) return { page, status: "unchanged" };
  return { page, status: "changed", diff: lineDiff(before, after) };
}

export function pageDiff(beforePages: string[], afterPages: string[]): PageDiff {
  const count = Math.max(beforePages.length, afterPages.length);
  const pages = Array.from({ length: count }, (_, k) =>
    comparePage(k + 1, beforePages[k], afterPages[k]),
  );
  const tally = (status: PageResult["status"]) => pages.filter((p) => p.status === status).length;
  return {
    pages,
    summary: {
      unchanged: tally("unchanged"),
      changed: tally("changed"),
      added: tally("added"),
      removed: tally("removed"),
    },
  };
}
