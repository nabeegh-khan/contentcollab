// compareVersions (#23, ARCHITECTURE D33): which versions may be compared and what comes back, with the
// database and storage replaced by two functions, so no Postgres or object store is needed.
import { describe, expect, it } from "@jest/globals";
import { HttpError } from "./httpError.js";
import { compareVersions, MAX_VERSION_BYTES, type CompareDeps } from "./versionCompare.js";

const DOC = "11111111-1111-4111-8111-111111111111";
const V1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const V2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOT_FOUND = 404;
const BAD_REQUEST = 400;
const UNSUPPORTED = 415;
const TOO_LARGE_STATUS = 413;
const SECOND = 2;
const SMALL = 10;
const MANY = 2500;
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Row = Awaited<ReturnType<CompareDeps["loadVersion"]>>;
const row = (id: string, over: Partial<NonNullable<Row>> = {}): NonNullable<Row> => ({
  id,
  number: id === V1 ? 1 : SECOND,
  filename: "notes.md",
  contentType: "text/markdown",
  size: SMALL,
  objectKey: `k/${id}`,
  ...over,
});

function deps(rows: Record<string, Row>, texts: Record<string, string>): CompareDeps {
  return {
    loadVersion: async (_doc, id) => rows[id] ?? null,
    readText: async (key) => texts[key] ?? "",
  };
}

const failure = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as HttpError;

describe("compareVersions", () => {
  it("returns both versions' details and the line diff", async () => {
    const d = deps(
      { [V1]: row(V1), [V2]: row(V2) },
      { [`k/${V1}`]: "a\nb\n", [`k/${V2}`]: "a\nc\n" },
    );
    const r = await compareVersions(DOC, V1, V2, d);
    expect(r.from).toMatchObject({ id: V1, number: 1, filename: "notes.md" });
    expect(r.to).toMatchObject({ id: V2, number: SECOND });
    expect([r.added, r.removed]).toEqual([1, 1]);
    expect(r.lines.map((l) => l.op)).toEqual(["keep", "remove", "add"]);
  });

  it("is 404 when a version is not one of this document's", async () => {
    const e = await failure(compareVersions(DOC, V1, OTHER, deps({ [V1]: row(V1) }, {})));
    expect([e.status, e.code]).toEqual([NOT_FOUND, "NOT_FOUND"]);
  });

  it("is 400 when from and to are the same version", async () => {
    const e = await failure(compareVersions(DOC, V1, V1, deps({ [V1]: row(V1) }, {})));
    expect([e.status, e.code]).toEqual([BAD_REQUEST, "VALIDATION"]);
  });

  it("is 415 for a type that is not text, naming the version", async () => {
    const d = deps({ [V1]: row(V1), [V2]: row(V2, { contentType: "application/pdf" }) }, {});
    const e = await failure(compareVersions(DOC, V1, V2, d));
    expect([e.status, e.code]).toEqual([UNSUPPORTED, "UNSUPPORTED_TYPE"]);
  });

  it("is 413 above the size limit, before reading any file", async () => {
    let reads = 0;
    const d = deps({ [V1]: row(V1), [V2]: row(V2, { size: MAX_VERSION_BYTES + 1 }) }, {});
    d.readText = async () => {
      reads += 1;
      return "";
    };
    const e = await failure(compareVersions(DOC, V1, V2, d));
    expect([e.status, e.code]).toEqual([TOO_LARGE_STATUS, "TOO_LARGE"]);
    expect(reads).toBe(0);
  });

  it("is 413 when the diff itself is too large for the module's limits", async () => {
    const d = deps({ [V1]: row(V1), [V2]: row(V2) }, {});
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
    d.readText = async (key) => (key.endsWith(V1) ? lines(MANY) : lines(MANY + 1) + "z");
    const e = await failure(compareVersions(DOC, V1, V2, d));
    expect([e.status, e.code]).toEqual([TOO_LARGE_STATUS, "TOO_LARGE"]);
  });
});
