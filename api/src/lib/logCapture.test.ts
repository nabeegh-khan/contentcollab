import { describe, expect, it } from "@jest/globals";
import { captureStdout } from "./logCapture.js";

// The capture is what makes "only JSON lines" testable, so it is tested too:
// Jest replaces console, so a console call never reaches process.stdout and
// would slip past a capture that watched only process.stdout.write.
describe("captureStdout", () => {
  it("fails the read when anything was written through console.log", () => {
    const out = captureStdout();
    try {
      console.log("plain text line");
      expect(() => out.lines()).toThrow("console.log: plain text line");
    } finally {
      out.restore();
    }
  });

  it.each(["error", "warn"] as const)("fails on console.%s as well", (method) => {
    const out = captureStdout();
    try {
      console[method]("oops");
      expect(() => out.lines()).toThrow(`console.${method}: oops`);
    } finally {
      out.restore();
    }
  });

  it("reads the JSON lines written to standard output", () => {
    const out = captureStdout();
    try {
      process.stdout.write(`${JSON.stringify({ msg: "a" })}\n`);
      expect(out.lines()).toEqual([{ msg: "a" }]);
    } finally {
      out.restore();
    }
  });
});
