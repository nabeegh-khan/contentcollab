import { describe, expect, it } from "@jest/globals";
import { prometheusRange, seriesFrom, SERIES_QUERIES } from "./series.js";

// Per-pod CPU and memory over the last 15 minutes (D31 follow-up), from the cAdvisor series Prometheus scrapes.
const matrix = (rows: { pod: string; values: [number, string][] }[]) => ({
  status: "success",
  data: {
    resultType: "matrix",
    result: rows.map((r) => ({ metric: { pod: r.pod }, values: r.values })),
  },
});
const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("prometheusRange", () => {
  it("asks query_range with start, end and step, and returns the series by pod", async () => {
    const seen: string[] = [];
    const range = prometheusRange("http://p:9090", (url) => {
      seen.push(String(url));
      return reply(
        matrix([
          {
            pod: "api-a",
            values: [
              [100, "0.5"],
              [115, "0.75"],
            ],
          },
        ]),
      );
    });
    const out = await range("up", 100, 1000, 15);
    expect(seen[0]).toContain(
      "http://p:9090/api/v1/query_range?query=up&start=100&end=1000&step=15",
    );
    expect(out).toEqual([
      {
        pod: "api-a",
        points: [
          { t: 100, v: 0.5 },
          { t: 115, v: 0.75 },
        ],
      },
    ]);
  });

  it("drops a NaN sample, and throws on an error status", async () => {
    const range = prometheusRange("http://p", () =>
      reply(
        matrix([
          {
            pod: "a",
            values: [
              [1, "NaN"],
              [2, "3"],
            ],
          },
        ]),
      ),
    );
    expect((await range("x", 0, 1, 1))[0]?.points).toEqual([{ t: 2, v: 3 }]);
    await expect(prometheusRange("http://p", () => reply({}, 500))("x", 0, 1, 1)).rejects.toThrow();
  });
});

describe("seriesFrom", () => {
  it("reads CPU in millicores and memory in MiB for the 15 minutes before now, at 15 s steps", async () => {
    const asked: { q: string; start: number; end: number; step: number }[] = [];
    const out = await seriesFrom(
      async (q, start, end, step) => {
        asked.push({ q, start, end, step });
        return q === SERIES_QUERIES.cpu
          ? [{ pod: "api-a", points: [{ t: 1, v: 0.25 }] }]
          : [{ pod: "api-a", points: [{ t: 1, v: 104857600 }] }];
      },
      () => 2_000_000_000,
    );
    expect(asked.map((a) => a.step)).toEqual([15, 15]);
    expect(asked[0]).toMatchObject({ start: 2_000_000 - 900, end: 2_000_000 });
    expect(out).toEqual({
      windowSeconds: 900,
      stepSeconds: 15,
      cpu: [{ pod: "api-a", points: [{ t: 1, v: 250 }] }],
      memory: [{ pod: "api-a", points: [{ t: 1, v: 100 }] }],
    });
  });

  it("uses the container series of the app namespace and leaves out the pause container", () => {
    expect(SERIES_QUERIES.cpu).toContain('namespace="contentcollab"');
    expect(SERIES_QUERIES.cpu).toContain('container!=""');
    expect(SERIES_QUERIES.cpu).toContain("rate(container_cpu_usage_seconds_total");
    expect(SERIES_QUERIES.memory).toContain("container_memory_working_set_bytes");
  });
});
