import type { Job } from "bullmq";

// The first job type: proves the queue end to end. Later jobs (summaries,
// email, imports) follow the same shape: a named handler that returns a
// result and throws to be retried.
export interface PingData {
  message: string;
}

export async function ping(job: Job<PingData>): Promise<{ echoed: string }> {
  return { echoed: job.data.message };
}
