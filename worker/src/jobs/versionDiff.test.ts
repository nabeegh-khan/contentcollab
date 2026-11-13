// The version-diff job (#23, D21): takes the two versions' contents inline until #116 stores
// versions, and returns the diff; bad input fails the job instead of returning a wrong result.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Job } from "bullmq";
import { versionDiff, type VersionDiffData } from "./versionDiff.js";

const job = (data: unknown) => ({ data }) as Job<VersionDiffData>;
// The job's error names what was wrong with its input
const failsWith = (text: string) => (err: unknown) => err instanceof Error && err.message.includes(text);

test("text versions give a line diff", async () => {
  const r = await versionDiff(job({ kind: "text", before: "a\nb", after: "a\nc" }));
  assert.equal(r.kind, "text");
  assert.ok(r.kind === "text" && r.diff.added === 1 && r.diff.removed === 1);
});

test("PDF page texts give a page diff", async () => {
  const r = await versionDiff(job({ kind: "pages", before: ["p1"], after: ["p1", "p2"] }));
  assert.ok(r.kind === "pages" && r.diff.summary.added === 1);
});

test("an unknown kind or missing content fails the job", async () => {
  await assert.rejects(versionDiff(job({ kind: "video", before: "", after: "" })), failsWith("kind"));
  await assert.rejects(versionDiff(job({ kind: "text", before: "a" })), failsWith("before and after"));
  await assert.rejects(versionDiff(job({ kind: "pages", before: ["a"], after: "b" })), failsWith("before and after"));
});
