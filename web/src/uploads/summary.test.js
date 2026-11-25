// The one-line outcome of a batch, for the toast (one toast per drop, not per file; D40).
import { describe, expect, it } from "vitest";
import { summarizeBatch } from "./summary.js";

const done = (name) => ({ name, status: "done", message: "ok" });
const failed = (name, message = "refused") => ({ name, status: "failed", message });

describe("summarizeBatch", () => {
  it("names a single uploaded file", () => {
    expect(summarizeBatch([done("a.pdf")])).toEqual({ kind: "success", text: "a.pdf uploaded." });
  });

  it("counts several uploaded files", () => {
    expect(summarizeBatch([done("a"), done("b"), done("c")])).toEqual({
      kind: "success",
      text: "3 files uploaded.",
    });
  });

  it("gives the reason when the one file failed", () => {
    expect(summarizeBatch([failed("a.pdf", "Too big.")])).toEqual({
      kind: "error",
      text: "a.pdf was not uploaded: Too big.",
    });
  });

  it("counts a mixed batch and is an error", () => {
    expect(summarizeBatch([done("a"), done("b"), failed("c")])).toEqual({
      kind: "error",
      text: "2 uploaded, 1 failed.",
    });
  });

  it("counts a batch where every file failed", () => {
    expect(summarizeBatch([failed("a"), failed("b")])).toEqual({
      kind: "error",
      text: "None of the 2 files were uploaded.",
    });
  });
});
