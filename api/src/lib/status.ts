import type { Histogram } from "prom-client";

// Numbers for the status page (#30, ARCHITECTURE D23).

// The worker's BullMQ queue (worker/src/queue.ts, QUEUE_NAME). BullMQ keeps waiting jobs in a list
// and prioritized ones in a sorted set (src/classes/queue-getters.ts), under "bull:<queue>:<type>"
// (src/classes/queue-keys.ts).
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
  /** A quantile fell above the top bucket: its value is the top bound, read as "more than". */
  overTopBucket: boolean;
}

/** Probes, scrapes and the status page's own polling would swamp an idle pod's figures. */
export const EXCLUDED_ROUTE_PREFIXES = ["/health", "/metrics", "/api/v1/status"];

const MEDIAN = 0.5;
const P95 = 0.95;

type Bucket = { le: number; count: number };
type Quantile = { seconds: number | null; over: boolean };

/**
 * The upper bound of the first bucket whose cumulative count reaches quantile q of the total; above
 * the top bucket, the top bound flagged as over (as Prometheus's histogram_quantile does).
 */
function quantile(buckets: Bucket[], total: number, q: number): Quantile {
  if (total === 0) return { seconds: null, over: false };
  const hit = buckets.find((b) => b.count >= q * total);
  if (hit) return { seconds: hit.le, over: false };
  return { seconds: buckets[buckets.length - 1]?.le ?? null, over: true };
}

const excluded = (route: unknown) =>
  typeof route === "string" && EXCLUDED_ROUTE_PREFIXES.some((p) => route.startsWith(p));

/**
 * p50 and p95 of this pod's requests since it started, from the request histogram: each is the upper
 * bound of the bucket it falls in, so it reads "at most". Every route and method is added up, except
 * probes, scrapes and this endpoint (EXCLUDED_ROUTE_PREFIXES).
 */
export async function latencyFrom(histogram: Histogram<string>): Promise<Latency> {
  const { values } = await histogram.get();
  // Cumulative bucket counts by bound, summed over every label set; the +Inf bucket is the total
  const byBound = values
    .filter((v) => v.metricName?.endsWith("_bucket") && !excluded(v.labels.route))
    .reduce((acc, v) => {
      const le = v.labels.le === "+Inf" ? Infinity : Number(v.labels.le);
      acc.set(le, (acc.get(le) ?? 0) + v.value);
      return acc;
    }, new Map<number, number>());
  const total = byBound.get(Infinity) ?? 0;
  const finite = [...byBound.entries()]
    .filter(([le]) => Number.isFinite(le))
    .map(([le, count]) => ({ le, count }))
    .sort((a, b) => a.le - b.le);
  const p50 = quantile(finite, total, MEDIAN);
  const p95 = quantile(finite, total, P95);
  return {
    requests: total,
    p50Seconds: p50.seconds,
    p95Seconds: p95.seconds,
    overTopBucket: p50.over || p95.over,
  };
}
