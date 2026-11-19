import type { Job } from "bullmq";
import { lineDiff, pageDiff, type LineDiff, type PageDiff } from "../lib/diff.js";

// The version-diff job (#23, ARCHITECTURE D21). Until versions are stored (#116) the two contents come
// inline: text for text, Markdown and code; page texts for PDFs. A later step reads them from Spaces.
export type VersionDiffData =
  | { kind: "text"; before: string; after: string }
  | { kind: "pages"; before: string[]; after: string[] };

export type VersionDiffResult =
  { kind: "text"; diff: LineDiff } | { kind: "pages"; diff: PageDiff };

const isPages = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((p) => typeof p === "string");

// Bad input fails the job (and BullMQ records why) instead of returning a misleading diff
export async function versionDiff(job: Job<VersionDiffData>): Promise<VersionDiffResult> {
  const data = job.data as { kind?: unknown; before?: unknown; after?: unknown };
  if (data.kind === "text") {
    if (typeof data.before !== "string" || typeof data.after !== "string") {
      throw new Error("version-diff: text needs before and after as strings");
    }
    return { kind: "text", diff: lineDiff(data.before, data.after) };
  }
  if (data.kind === "pages") {
    if (!isPages(data.before) || !isPages(data.after)) {
      throw new Error("version-diff: pages needs before and after as lists of page texts");
    }
    return { kind: "pages", diff: pageDiff(data.before, data.after) };
  }
  throw new Error(`version-diff: unknown kind ${JSON.stringify(data.kind)}`);
}
