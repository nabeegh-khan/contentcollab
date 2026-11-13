import type { Histogram } from "prom-client";

// Numbers for the status page (#30, ARCHITECTURE D23).

// The worker's BullMQ queue (worker/src/queue.ts, QUEUE_NAME). BullMQ keeps waiting jobs in a list
// and prioritized ones in a sorted set under "bull:<queue>:<type>" (bullmq src/classes/queue-getters.ts).
export const QUEUE_KEYS = {
  waiting: "bull:contentcollab:wait",
  prioritized: "bull:contentcollab:prioritized",
} as const;

export interface QueueClient {
  lLen(key: string): Promise<number>;
  zCard(key: string): Promise<number>;
}

/** Jobs not yet picked up by a worker. */
export async function queueDepth(client: QueueClient): Promise<number> {
  const [waiting, prioritized] = await Promise.all([
    client.lLen(QUEUE_KEYS.waiting),
    client.zCard(QUEUE_KEYS.prioritized),
  ]);
  return waiting + prioritized;
}

export interface Latency {
  requests: number;
  p50Seconds: number | null;
  p95Seconds: number | null;
}

const MEDIAN = 0.5;
const P95 = 0.95;

type Bucket = { le: number; count: number };

/** The upper bound of the first bucket whose cumulative count reaches quantile q of the total. */
const quantile = (buckets: Bucket[], total: number, q: number): number | null =>
  total === 0 ? null : (buckets.find((b) => b.count >= q * total)?.le ?? null);

/**
 * p50 and p95 of this pod's requests since it started, from the request histogram: each is the upper
 * bound of the bucket it falls in, so it reads "at most". Every route and method is added up.
 */
export async function latencyFrom(histogram: Histogram<string>): Promise<Latency> {
  const { values } = await histogram.get();
  // Cumulative bucket counts by bound, summed over every label set; the +Inf bucket is the total
  const byBound = values
    .filter((v) => v.metricName?.endsWith("_bucket"))
    .reduce((acc, v) => {
      const le = v.labels.le === "+Inf" ? Infinity : Number(v.labels.le);
      acc.set(le, (acc.get(le) ?? 0) + v.value);
      return acc;
    }, new Map<number, number>());
  const buckets = [...byBound.entries()]
    .map(([le, count]) => ({ le, count }))
    .sort((a, b) => a.le - b.le);
  const total = byBound.get(Infinity) ?? 0;
  const finite = buckets.filter((b) => Number.isFinite(b.le));
  return {
    requests: total,
    p50Seconds: quantile(finite, total, MEDIAN),
    p95Seconds: quantile(finite, total, P95),
  };
}
