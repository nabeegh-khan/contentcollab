import { describe, expect, it } from "@jest/globals";
import { prometheusQuery, trafficFrom, TRAFFIC_QUERIES } from "./traffic.js";

// The traffic card (D31): four PromQL reads, checked against the cluster's Prometheus 3.16.0 on 21 Nov 2026.
const vector = (value: string) => ({
  status: "success",
  data: { resultType: "vector", result: [{ metric: {}, value: [1763753000, value] }] },
});
const empty = { status: "success", data: { resultType: "vector", result: [] } };
const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("prometheusQuery", () => {
  it("asks the instant-query API with the expression and returns the first value as a number", async () => {
    const seen: string[] = [];
    const query = prometheusQuery("http://prometheus.observability.svc:9090", (url) => {
      seen.push(String(url));
      return reply(vector("0.4"));
    });
    expect(await query("up")).toBe(0.4);
    expect(seen[0]).toBe("http://prometheus.observability.svc:9090/api/v1/query?query=up");
  });

  it("is null for an empty vector and for NaN (no requests in the window)", async () => {
    expect(await prometheusQuery("http://p", () => reply(empty))("x")).toBeNull();
    expect(await prometheusQuery("http://p", () => reply(vector("NaN")))("x")).toBeNull();
  });

  it("throws on an error status or a reply that is not a success", async () => {
    await expect(prometheusQuery("http://p", () => reply({}, 500))("x")).rejects.toThrow();
    await expect(
      prometheusQuery("http://p", () => reply({ status: "error", error: "bad" }))("x"),
    ).rejects.toThrow();
  });
});

describe("trafficFrom", () => {
  it("reads rate, p50, p95 and error percent with the panel's queries", async () => {
    const asked: string[] = [];
    const answers = new Map<string, number | null>([
      [TRAFFIC_QUERIES.rate, 0.4],
      [TRAFFIC_QUERIES.p50, 0.006],
      [TRAFFIC_QUERIES.p95, 0.012],
      [TRAFFIC_QUERIES.errorPercent, 0],
    ]);
    const out = await trafficFrom(async (q) => {
      asked.push(q);
      return answers.get(q) ?? null;
    });
    expect(out).toEqual({
      windowSeconds: 60,
      requestsPerSecond: 0.4,
      p50Seconds: 0.006,
      p95Seconds: 0.012,
      errorPercent: 0,
      noTraffic: false,
    });
    expect(asked).toHaveLength(4);
  });

  it("says noTraffic and leaves the latencies null when nothing was requested", async () => {
    const out = await trafficFrom(async (q) => (q === TRAFFIC_QUERIES.rate ? 0 : null));
    expect(out).toMatchObject({
      noTraffic: true,
      p50Seconds: null,
      p95Seconds: null,
      errorPercent: null,
    });
  });

  it("leaves the panel's own polling and the scrape out of the numbers", () => {
    expect(TRAFFIC_QUERIES.rate).toContain('route!~"/metrics|/api/v1/ops(/.*)?"');
    expect(TRAFFIC_QUERIES.errorPercent).toContain("or vector(0)");
  });
});
