// The line diff copied from the worker (#23, ARCHITECTURE D33): a changed line reads as removed, then added.
import { describe, expect, it } from "@jest/globals";
import { DiffTooLargeError, MAX_INPUT_CHARS, lineDiff } from "./diff.js";

describe("lineDiff", () => {
  it("marks a changed line as removed then added, and keeps the others with their numbers", () => {
    const d = lineDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(d.lines).toEqual([
      { op: "keep", text: "a", before: 1, after: 1 },
      { op: "remove", text: "b", before: 2 },
      { op: "add", text: "B", after: 2 },
      { op: "keep", text: "c", before: 3, after: 3 },
    ]);
    expect([d.added, d.removed]).toEqual([1, 1]);
  });

  it("treats CRLF like LF and an empty side as no lines", () => {
    expect(lineDiff("a\r\nb\r\n", "a\nb\n").added).toBe(0);
    expect(lineDiff("", "x\n").lines).toEqual([{ op: "add", text: "x", after: 1 }]);
  });

  it("refuses input above the character limit", () => {
    expect(() => lineDiff("x".repeat(MAX_INPUT_CHARS + 1), "")).toThrow(DiffTooLargeError);
  });
});
