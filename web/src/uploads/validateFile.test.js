// The browser-side check of one file against the API's own limits (api/src/lib/parseUpload.ts, D40).
import { describe, expect, it } from "vitest";
import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE, validateFile } from "./validateFile.js";

function file(name, type, size) {
  const made = new File(["x"], name, { type });
  if (size !== undefined) Object.defineProperty(made, "size", { value: size });
  return made;
}

describe("validateFile", () => {
  it("accepts each extension with the type the API accepts for it", () => {
    const pairs = [
      ["a.pdf", "application/pdf"],
      ["a.png", "image/png"],
      ["a.jpg", "image/jpeg"],
      ["a.jpeg", "image/jpeg"],
      ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["a.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["a.txt", "text/plain"],
      ["a.md", "text/markdown"],
      ["a.md", "text/plain"],
    ];
    for (const [name, type] of pairs) expect(validateFile(file(name, type))).toBeNull();
  });

  it("lists the nine extensions the API allows", () => {
    expect(ALLOWED_EXTENSIONS).toEqual([
      ".pdf",
      ".png",
      ".jpg",
      ".jpeg",
      ".docx",
      ".xlsx",
      ".pptx",
      ".txt",
      ".md",
    ]);
  });

  it("reads the extension in any case, as the API does", () => {
    expect(validateFile(file("SCAN.PDF", "application/pdf"))).toBeNull();
  });

  it("refuses an extension that is not allowed, and names the allowed ones", () => {
    const message = validateFile(file("run.exe", "application/octet-stream"));
    expect(message).toMatch(/not allowed/i);
    expect(message).toContain(".pdf");
  });

  it("refuses a file with no extension", () => {
    expect(validateFile(file("README", "text/plain"))).toMatch(/not allowed/i);
  });

  it("refuses a type that does not belong to the extension", () => {
    expect(validateFile(file("a.pdf", "text/plain"))).toMatch(/not allowed/i);
  });

  it("refuses a file the browser gives no type, with a message that says so", () => {
    expect(validateFile(file("notes.md", ""))).toMatch(/type/i);
  });

  it("accepts exactly 50 MiB and refuses one byte more", () => {
    expect(MAX_FILE_SIZE).toBe(50 * 1024 * 1024);
    expect(validateFile(file("a.pdf", "application/pdf", MAX_FILE_SIZE))).toBeNull();
    expect(validateFile(file("a.pdf", "application/pdf", MAX_FILE_SIZE + 1))).toMatch(
      /too large.*50 MiB/i,
    );
  });

  it("refuses an empty file", () => {
    expect(validateFile(file("a.pdf", "application/pdf", 0))).toMatch(/empty/i);
  });
});
