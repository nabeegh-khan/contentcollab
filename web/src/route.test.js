// Tests for the hash address parser: which page `location.hash` asks for (D28).
import { describe, expect, it } from "vitest";
import { documentHash, isId, parseHash } from "./route.js";

const DOC = "11111111-1111-4111-8111-111111111111";
const VER = "22222222-2222-4222-8222-222222222222";

describe("parseHash", () => {
  it("shows the documents page for an empty hash, a bare # and #/", () => {
    expect(parseHash("")).toEqual({ name: "documents" });
    expect(parseHash("#")).toEqual({ name: "documents" });
    expect(parseHash("#/")).toEqual({ name: "documents" });
  });

  it("reads the document and version ids of a version address", () => {
    expect(parseHash(`#/documents/${DOC}/versions/${VER}`)).toEqual({
      name: "version",
      documentId: DOC,
      versionId: VER,
    });
  });

  it("accepts upper-case ids, as the API does", () => {
    const route = parseHash(`#/documents/${DOC.toUpperCase()}/versions/${VER.toUpperCase()}`);
    expect(route.name).toBe("version");
  });

  it("falls back to the documents page for anything it does not know", () => {
    expect(parseHash("#/documents/not-a-uuid/versions/also-not")).toEqual({ name: "documents" });
    expect(parseHash(`#/documents/${DOC}`)).toEqual({ name: "documents" });
    expect(parseHash(`#/documents/${DOC}/versions/${VER}/extra`)).toEqual({ name: "documents" });
    expect(parseHash("#/admin")).toEqual({ name: "documents" });
  });
});

describe("documentHash", () => {
  it("builds the address parseHash reads back", () => {
    const hash = documentHash(DOC, VER);
    expect(hash).toBe(`#/documents/${DOC}/versions/${VER}`);
    expect(parseHash(hash)).toEqual({ name: "version", documentId: DOC, versionId: VER });
  });
});

describe("isId", () => {
  it("accepts one id, in either case, and nothing around it", () => {
    expect(isId(DOC)).toBe(true);
    expect(isId(DOC.toUpperCase())).toBe(true);
    expect(isId(` ${DOC}`)).toBe(false);
    expect(isId(`${DOC}x`)).toBe(false);
    expect(isId("")).toBe(false);
  });
});
