// The summarize job (#26, D22): text comes inline until comments and versions are stored; the
// provider's reply is checked before it is returned, so a bad reply fails the job.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Job } from "bullmq";
import { summarizeWith, type SummarizeData } from "./summarize.js";
import { stubProvider, type SummaryProvider } from "../lib/summary.js";

const job = (data: unknown) => ({ data }) as Job<SummarizeData>;
const failsWith = (text: string) => (err: unknown) =>
  err instanceof Error && err.message.includes(text);

test("a thread is summarised with the stub provider", async () => {
  const r = await summarizeWith(stubProvider)(job({ kind: "thread", text: "A: limit?\nB: 50 MB" }));
  assert.equal(typeof r.summary, "string");
  assert.ok(Array.isArray(r.tags));
});

test("bad input fails the job", async () => {
  const run = summarizeWith(stubProvider);
  await assert.rejects(run(job({ kind: "email", text: "x" })), failsWith("kind"));
  await assert.rejects(run(job({ kind: "thread", text: "" })), failsWith("text"));
});

test("a reply outside the shape fails the job", async () => {
  const bad: SummaryProvider = { summarize: async () => ({ summary: "ok", tags: ["Not Ok"] }) };
  await assert.rejects(
    summarizeWith(bad)(job({ kind: "version", text: "+ x" })),
    failsWith("tags"),
  );
});
