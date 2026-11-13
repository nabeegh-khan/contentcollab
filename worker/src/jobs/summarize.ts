import type { Job } from "bullmq";
import {
  checkReply,
  type SummaryKind,
  type SummaryProvider,
  type SummaryReply,
} from "../lib/summary.js";

// The summarize job (#26, ARCHITECTURE D22). Until comments and versions are stored the text comes
// inline: a thread's comments, or a version diff. Nothing is saved yet; the reply is the job's result.
export interface SummarizeData {
  kind: SummaryKind;
  text: string;
}

const KINDS: readonly string[] = ["thread", "version"];
/** What one job may send to the model: about 25,000 tokens of text, a cost and context-window cap. */
export const MAX_TEXT_CHARS = 100_000;

export function summarizeWith(provider: SummaryProvider) {
  return async (job: Job<SummarizeData>): Promise<SummaryReply> => {
    const data = job.data as { kind?: unknown; text?: unknown };
    if (typeof data.kind !== "string" || !KINDS.includes(data.kind)) {
      throw new Error(`summarize: unknown kind ${JSON.stringify(data.kind)}`);
    }
    if (
      typeof data.text !== "string" ||
      data.text.trim() === "" ||
      data.text.length > MAX_TEXT_CHARS
    ) {
      throw new Error(
        `summarize: text must be a non-empty string of at most ${MAX_TEXT_CHARS} characters`,
      );
    }
    return checkReply(await provider.summarize(data.kind as SummaryKind, data.text));
  };
}
