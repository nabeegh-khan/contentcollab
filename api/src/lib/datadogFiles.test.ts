import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { registry } from "./metrics.js";

// The Datadog files are imported by hand, so nothing else checks them. These
// tests keep them parseable and tied to what /metrics really exports: a metric
// or tag renamed in lib/metrics.ts fails here instead of leaving a dashboard
// empty.
const dir = new URL("../../../k8s/doks/datadog/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, dir), "utf8");

type Monitor = {
  name: string;
  type: string;
  query: string;
  message: string;
  tags: string[];
  options: { thresholds: { critical: number; warning?: number } };
};
type Widget = {
  definition: { type: string; title?: string; query?: string; time?: { live_span?: string } };
};
type Dashboard = { title: string; layout_type: string; widgets: Widget[] };

// The thresholds in ARCHITECTURE (failure table): alert above 2%, warn above 1%
const CRITICAL_SHARE = 0.02;
const WARNING_SHARE = 0.01;
const MIN_WIDGETS = 4;

// What the OpenMetrics check submits: counters without _total plus .count,
// histograms as .sum, .count and .bucket, all under the namespace in api.yaml
const NAMESPACE = "contentcollab";

// Matches a trailing "_total": "http_requests_total" becomes "http_requests";
// "http_request_duration_seconds" is left alone.
// Try it: https://regex101.com/?regex=_total%24
const TOTAL_SUFFIX = /_total$/;

async function exportedDatadogMetrics(): Promise<Map<string, string[]>> {
  const all = (await registry.getMetricsAsJSON()).filter((m) => m.name.startsWith("http_"));
  const entries = all.flatMap((metric) => {
    const labels = (registry.getSingleMetric(metric.name) as unknown as { labelNames: string[] })
      .labelNames;
    const base = metric.name.replace(TOTAL_SUFFIX, "");
    const suffixes =
      String(metric.type) === "histogram" ? [".sum", ".count", ".bucket"] : [".count"];
    return suffixes.map((suffix): [string, string[]] => [`${NAMESPACE}.${base}${suffix}`, labels]);
  });
  return new Map(entries);
}

// Finds a Datadog metric with its tag filter and optional "by {...}" group:
// matches "contentcollab.http_requests.count{status_class:5xx} by {route}";
// rejects "contentcollab.http_requests.count" (no filter braces).
// Try it: https://regex101.com/?regex=(contentcollab%5C.%5Ba-z_.%5D%2B)%5C%7B(%5B%5E%7D%5D*)%5C%7D(%3F%3A%20by%20%5C%7B(%5B%5E%7D%5D*)%5C%7D)%3F
const METRIC_USE = /(contentcollab\.[a-z_.]+)\{([^}]*)\}(?: by \{([^}]*)\})?/g;

describe("monitor-error-rate.json", () => {
  const monitor = JSON.parse(read("monitor-error-rate.json")) as Monitor;

  it("is a metric monitor on the 5xx share per route over five minutes", () => {
    expect(monitor.type).toBe("query alert");
    expect(monitor.query.startsWith("sum(last_5m):")).toBe(true);
    expect(monitor.query).toContain(
      `${NAMESPACE}.http_requests.count{status_class:5xx} by {route}`,
    );
    expect(monitor.query).toContain(`${NAMESPACE}.http_requests.count{*} by {route}`);
    expect(monitor.query).toContain(".as_count()");
  });

  it("alerts above 2% and warns above 1%, the threshold in ARCHITECTURE", () => {
    expect(monitor.options.thresholds.critical).toBe(CRITICAL_SHARE);
    expect(monitor.options.thresholds.warning).toBe(WARNING_SHARE);
  });

  it("names the route in the message and gives a log query Datadog can run", () => {
    // The route value contains ":" so it is quoted in the log search; a status
    // range is the documented way to match 5xx (no wildcard on numbers)
    expect(monitor.message).toContain('@http.route:"{{route.name}}"');
    expect(monitor.message).toContain("@http.status_code:[500 TO 599]");
    expect(monitor.message).not.toContain("5*");
    expect(monitor.message).not.toContain("{{threshold}}");
  });
});

describe("dashboard.json", () => {
  const dashboard = JSON.parse(read("dashboard.json")) as Dashboard;

  it("is an ordered dashboard with widgets", () => {
    expect(dashboard.title.length).toBeGreaterThan(0);
    expect(dashboard.layout_type).toBe("ordered");
    expect(dashboard.widgets.length).toBeGreaterThanOrEqual(MIN_WIDGETS);
  });

  it("uses only metrics and tags that /metrics exports", async () => {
    const exported = await exportedDatadogMetrics();
    const text = read("dashboard.json") + read("monitor-error-rate.json");
    const uses = [...text.matchAll(METRIC_USE)];
    expect(uses.length).toBeGreaterThan(0);
    uses.forEach(([, metric, filter, groupBy]) => {
      const labels = exported.get(metric!);
      expect(labels).toBeDefined();
      [...(filter ?? "").split(","), ...(groupBy ?? "").split(",")]
        .map((tag) => tag.trim().split(":")[0]!)
        .filter((tag) => tag !== "" && tag !== "*")
        .forEach((tag) => expect(labels).toContain(tag));
    });
  });

  it("has a widget for the error rate and one for the request log", () => {
    expect(JSON.stringify(dashboard)).toContain("status_class:5xx");
    expect(dashboard.widgets.some((w) => w.definition.type === "log_stream")).toBe(true);
  });

  it("searches the request log by the attribute the API writes", () => {
    const stream = dashboard.widgets.find((w) => w.definition.type === "log_stream")?.definition;
    expect(stream?.query).toContain("kube_namespace:contentcollab");
    expect(stream?.query).toContain("@http.request_id:*");
  });

  it("sets the time frame its titles name", () => {
    const titled = (text: string) =>
      dashboard.widgets.find((w) => w.definition.title?.includes(text))?.definition;
    expect(titled("last 5 minutes")?.time?.live_span).toBe("5m");
    expect(titled("last hour")?.time?.live_span).toBe("1h");
  });
});
