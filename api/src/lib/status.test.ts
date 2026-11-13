import { describe, expect, it } from "@jest/globals";
import { Histogram, Registry } from "prom-client";
import { latencyFrom, queueDepth, QUEUE_KEYS } from "./status.js";
import { LATENCY_BUCKETS_SECONDS as BUCKETS } from "./metrics.js";

// The status page's numbers (#30): latency quantiles from this pod's request histogram, and the
// queue's waiting jobs from Redis. No Redis needed: the client is a stand-in.

const FAST = 0.004; // falls in the 5 ms bucket
const SLOW = 0.3; // falls in the 500 ms bucket
const FAST_COUNT = 90;
const SLOW_COUNT = 10;
const FIRST_BUCKET = BUCKETS[0];
const SLOW_BUCKET = BUCKETS.find((b) => b >= SLOW);

function histogramWith(samples: Array<[number, number]>) {
  const registry = new Registry();
  const h = new Histogram({
    name: "http_request_duration_seconds",
    help: "test",
    labelNames: ["method", "route"] as const,
    buckets: BUCKETS,
    registers: [registry],
  });
  samples.forEach(([seconds, times]) =>
    Array.from({ length: times }).forEach(() => h.observe({ method: "GET", route: "/x" }, seconds)),
  );
  return h;
}

describe("latencyFrom", () => {
  it("gives each quantile as the upper bound of the bucket it falls in", async () => {
    const h = histogramWith([
      [FAST, FAST_COUNT],
      [SLOW, SLOW_COUNT],
    ]);
    // 90 of 100 requests are in the first bucket: the median is there, the 95th is in the slow one
    expect(await latencyFrom(h)).toEqual({
      requests: FAST_COUNT + SLOW_COUNT,
      p50Seconds: FIRST_BUCKET,
      p95Seconds: SLOW_BUCKET,
      overTopBucket: false,
    });
  });

  it("adds up every route and method", async () => {
    const h = histogramWith([[FAST, 1]]);
    h.observe({ method: "POST", route: "/y" }, SLOW);
    expect((await latencyFrom(h)).requests).toBe(1 + 1);
  });

  it("has no quantiles before the first request", async () => {
    expect(await latencyFrom(histogramWith([]))).toEqual({
      requests: 0,
      p50Seconds: null,
      p95Seconds: null,
      overTopBucket: false,
    });
  });

  it("a quantile above the top bucket reads as the top bound, flagged, not as no data", async () => {
    const top = BUCKETS[BUCKETS.length - 1]!;
    const h = histogramWith([[top + top, SLOW_COUNT]]);
    expect(await latencyFrom(h)).toEqual({
      requests: SLOW_COUNT,
      p50Seconds: top,
      p95Seconds: top,
      overTopBucket: true,
    });
  });

  it("leaves out probes, scrapes and the status page's own polling", async () => {
    const h = histogramWith([[SLOW, 1]]);
    ["/health/", "/metrics/", "/api/v1/status/"].forEach((route) =>
      Array.from({ length: FAST_COUNT }).forEach(() => h.observe({ method: "GET", route }, FAST)),
    );
    expect(await latencyFrom(h)).toEqual({
      requests: 1,
      p50Seconds: SLOW_BUCKET,
      p95Seconds: SLOW_BUCKET,
      overTopBucket: false,
    });
  });
});

describe("queueDepth", () => {
  it("counts waiting and prioritized jobs of the contentcollab queue", async () => {
    const WAITING = 3;
    const PRIORITIZED = 2;
    const asked: string[] = [];
    const client = {
      lLen: async (key: string) => (asked.push(key), WAITING),
      zCard: async (key: string) => (asked.push(key), PRIORITIZED),
    };
    expect(await queueDepth(client)).toBe(WAITING + PRIORITIZED);
    expect(asked.sort()).toEqual([QUEUE_KEYS.prioritized, QUEUE_KEYS.waiting].sort());
    expect(QUEUE_KEYS).toEqual({
      waiting: "bull:contentcollab:wait",
      prioritized: "bull:contentcollab:prioritized",
    });
  });
});
